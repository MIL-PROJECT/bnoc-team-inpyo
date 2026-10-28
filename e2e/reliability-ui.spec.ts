import {test,expect,type Page} from '@playwright/test';

const people=['A','B','C'].map(id=>({personRef:id,department:'무선반',displayName:`검토${id}`,active:true,category:'병',rank:'상병',complete:true,serviceNumber:`TEST-${id}`,internalPhone:'',absences:[]}));
async function fixture(page:Page,role='bnoc',options:{directory?:()=>unknown;schedule?:(month:string)=>unknown|Promise<unknown>;command?:(body:any)=>unknown}={}) {
  page.on('dialog',dialog=>void dialog.accept());
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path==='/api/commands') {
      const value=options.command?.(route.request().postDataJSON());
      if(value===null)return route.abort('failed');
      return route.fulfill({json:value??{ok:true}});
    }
    const actor={id:role==='team'?'team-wireless':'bnoc',role,displayName:role==='team'?'무선반':'BNOC',department:role==='team'?'무선반':'BNOC',...(role==='team'?{teamId:'무선반'}:{})};
    const data=path==='/api/session'?{actor,teams:['무선반','유선반'],departments:['BNOC','무선반','유선반'],csrfToken:'fixture'}:
      path==='/api/personnel-roster'?await options.directory?.()??{entries:people,revision:1}:
      path==='/api/duty-schedules'?await options.schedule?.(url.searchParams.get('month')!)??{entries:[]}:
      path==='/api/personnel'?{date:url.searchParams.get('date'),total:3,current:3,absent:0,departments:[]}:
      path==='/api/situation'?{}:path==='/api/notifications/unseen'?{unseen:0}:path==='/api/work-overview'?{counts:{returned:0},items:[],byDepartment:[]}:{};
    await route.fulfill({json:{data,queriedAt:new Date().toISOString()}});
  });
}

test('reliability: profile edit keeps its original version after a newer directory read',async({page})=>{
  let version=1,reads=0;const commands:any[]=[];
  await fixture(page,'bnoc',{directory:()=>{reads++;return {entries:people,revision:version};},command:body=>{commands.push(body);return null;}});
  await page.goto('/personnel');await expect(page.locator('.personnel-summary')).toBeVisible();
  await page.locator('tr').filter({hasText:'검토A'}).getByRole('button',{name:'수정',exact:true}).click();
  const editor=page.locator('.personnel-editor');await editor.getByLabel('이름',{exact:true}).fill('로컬 수정');
  const beforeReads=reads;version=2;await page.getByLabel('기준일',{exact:true}).fill('2026-12-15');await expect.poll(()=>reads).toBeGreaterThan(beforeReads);
  await editor.getByRole('button',{name:'저장',exact:true}).click();await expect.poll(()=>commands.length).toBe(1);
  expect(commands[0].expectedRevision,'PROFILE_EDIT_MUST_KEEP_START_VERSION').toBe(1);
});

test('reliability: registration waits for the first directory version',async({page})=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await fixture(page,'bnoc',{directory:async()=>{await gate;return {entries:people,revision:7};}});
  try {
    await page.goto('/roster');await expect(page.getByRole('heading',{name:'부대 인원 명부',exact:true})).toBeVisible();
    const add=page.getByRole('button',{name:'인원 등록',exact:true});await expect(add).toBeDisabled();
    release();await expect(add).toBeEnabled();await add.click();await expect(page.getByRole('heading',{name:'인원 등록',exact:true})).toBeVisible();
  }finally{release();}
});

test('reliability: unknown absence save freezes fields and replays only the original operation',async({page})=>{
  const commands:any[]=[];
  await fixture(page,'bnoc',{directory:()=>({entries:people.map(person=>({...person,absences:person.personRef==='A'?[{absenceRef:'existing',absenceType:'교육',startDate:'2026-10-01',endDate:'2026-10-02',revision:1}]:[]})),revision:1}),command:body=>{commands.push(body);return commands.length===1?null:{ok:true};}});
  await page.goto('/roster');await page.getByRole('button',{name:'부재 등록',exact:true}).click();
  const editor=page.locator('.personnel-editor');await expect(editor).toBeVisible();await editor.locator('select').nth(0).selectOption('무선반');await editor.locator('select').nth(1).selectOption('A');
  await editor.getByRole('button',{name:'등록',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('저장 결과');
  await expect(page.getByRole('button',{name:'교육 2026-10-01 부재 수정',exact:true})).toBeDisabled();await expect(editor.locator('select').nth(2)).toBeDisabled();await expect(editor.getByRole('button',{name:'취소',exact:true})).toBeDisabled();
  await editor.getByRole('button',{name:'저장 결과 다시 확인',exact:true}).click();await expect.poll(()=>commands.length).toBe(2);
  expect(commands[1],'UNKNOWN_SAVE_MUST_REPLAY_ORIGINAL_COMMAND').toEqual(commands[0]);
});

test('reliability: delayed previous month cannot erase current calendar',async({page})=>{
  let started=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await fixture(page,'team',{schedule:async month=>{if(month==='2026-11'){started=true;await gate;}return {entries:[{date:`${month}-01`,seat:'team_night',scopeKey:'무선반',revision:1,people:[{personRef:month==='2026-12'?'B':'A'}]}]};}});
  try {
    await page.goto('/night-duty');await expect(page.getByText('불러오는 중…')).toHaveCount(0);await page.getByRole('button',{name:'월',exact:true}).click();
    await page.getByLabel('대상 월',{exact:true}).fill('2026-11');await expect.poll(()=>started).toBe(true);
    await page.getByLabel('대상 월',{exact:true}).fill('2026-12');const day=page.getByRole('button',{name:/^2026-12-01 근무자 보기/});await expect(day).toContainText('검토B');
    const oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/duty-schedules'&&new URL(response.url()).searchParams.get('month')==='2026-11');release();await oldResponse;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(day).toContainText('검토B');await expect(page.getByLabel('대상 월',{exact:true})).toHaveValue('2026-12');
  }finally{release();}
});

test('reliability: batch dates keep selections and one-date additions use append mode',async({page})=>{
  let command:any;
  await fixture(page,'team',{schedule:async month=>({entries:[{date:`${month}-02`,seat:'team_night',scopeKey:'무선반',revision:1,people:[{personRef:'A'}]}]}),command:body=>{command=body;return null;}});
  await page.goto('/night-duty');await expect(page.getByText('불러오는 중…')).toHaveCount(0);await page.getByRole('button',{name:'월',exact:true}).click();
  const month=await page.getByLabel('대상 월',{exact:true}).inputValue();await page.getByRole('button',{name:new RegExp(`^${month}-02 근무자 보기`)}).click();await page.getByRole('button',{name:'여러 날짜 편성',exact:true}).click();
  const added=page.getByRole('checkbox',{name:'상병 검토C · 무선반',exact:true});await added.check();
  await page.getByRole('button',{name:new RegExp(`^${month}-03 근무자 보기`)}).click();await expect(added).toBeChecked();
  await page.getByRole('button',{name:`${month}-03 선택 해제`,exact:true}).click();await expect(added).toBeChecked();
  await page.getByRole('button',{name:'1일 야간근무표 저장',exact:true}).click();await expect.poll(()=>command).toBeTruthy();
  expect(command.payload.mode,'ONE_DAY_APPEND_MUST_NOT_BECOME_REPLACE').toBe('append');expect(command.payload.entries[0].personRefs).toEqual(['C']);
});

test('reliability: team edit uses its own schedule revision when other teams are visible',async({page})=>{
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date());
  const date=`${month}-02`,commands:any[]=[];
  await fixture(page,'team',{schedule:()=>({entries:[
    {date,seat:'team_night',scopeKey:'무선반',revision:3,people:[{personRef:'A',displayName:'검토A',rank:'상병',department:'무선반',category:'병',active:true,conflict:false}]},
    {date,seat:'team_night',scopeKey:'유선반',revision:8,people:[{personRef:'outside',displayName:'다른반',rank:'병장',department:'유선반',category:'병',active:true,conflict:false}]}
  ]}),command:body=>{commands.push(body);return {ok:true};}});
  await page.goto('/night-duty');await expect(page.getByText('불러오는 중…')).toHaveCount(0);await page.getByRole('button',{name:'월',exact:true}).click();
  await page.getByRole('button',{name:new RegExp(`^${date} 근무자 보기`)}).click();await expect(page.getByRole('checkbox',{name:'상병 검토A · 무선반',exact:true})).toBeChecked();
  await page.getByRole('button',{name:'작업반 야간근무표 저장',exact:true}).click();await expect.poll(()=>commands.length).toBe(1);
  expect(commands[0].payload.entries[0].expectedRevision,'TEAM_REVISION_MUST_MATCH_OWN_SCOPE').toBe(3);
});

test('reliability: BNOC sees night duty and team can remove a transferred saved member',async({page})=>{
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date());
  const schedule={entries:[{date:`${month}-02`,seat:'team_night',scopeKey:'무선반',revision:1,people:[{personRef:'transferred',displayName:'기존 담당자',rank:'상병',department:'유선반',category:'병',active:true,conflict:true}]}]};
  await fixture(page,'bnoc',{schedule:()=>schedule});await page.goto('/night-duty');await page.getByRole('button',{name:'월',exact:true}).click();await expect(page.getByRole('button',{name:new RegExp(`^${month}-02 근무자 보기 · 편성 충돌`)})).toContainText('기존 담당자');
  await page.unrouteAll({behavior:'wait'});await fixture(page,'team',{schedule:()=>schedule});await page.reload();await expect(page.getByText('불러오는 중…')).toHaveCount(0);await page.getByRole('button',{name:'월',exact:true}).click();
  await page.getByRole('button',{name:new RegExp(`^${month}-02 근무자 보기 · 편성 충돌`)}).click();const old=page.locator('label').filter({hasText:'기존 편성: 소속/명부 변경'}).getByRole('checkbox');await expect(old).toBeChecked();await old.click();await expect(old).toHaveCount(0);
});
