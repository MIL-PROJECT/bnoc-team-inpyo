// Test runner responses only. Product authentication remains unmodified.
import { identities } from '../mock-provider/server.mjs';
export const teamIds=['무선반','유선반','전장반(전산장비)','정체반','암호반'];
export const teamSubjects=['team-wireless','team-wired','team-display','team-info','team-crypto'];
const sessions=new WeakMap();
export function testActor(role) {
  const id=role==='team'?'team-wireless':role==='admin'?'access-admin':role;
  const identity=identities.find(item=>item.subject===id);if(!identity)throw new Error('Unknown test subject');
  const index=teamSubjects.indexOf(id),teamId=teamIds[index];
  return {id,role:index>=0?'team':id==='access-admin'?'admin':id,displayName:identity.label,department:teamId??'요청 부서',...(teamId?{teamId}:{}),...(id==='access-admin'?{accessAdmin:true}:{})};
}
export async function setTestSession(page,role) {
  if(!sessions.has(page)) {
    sessions.set(page,null);
    await page.route(url=>url.pathname.startsWith('/api/'),route=>{
      const pathname=new URL(route.request().url()).pathname,current=sessions.get(page);
      if(pathname==='/api/auth/logout'){sessions.set(page,null);return route.fulfill({json:{ok:true}});}
      if(!current)return route.fulfill({status:401,json:{errorCode:'UNAUTHENTICATED'}});
      const data=pathname==='/api/session'?{actor:current,teams:teamIds,departments:['요청 부서',...teamIds],csrfToken:'test'}:pathname==='/api/situation'?{}:pathname==='/api/notifications/unseen'?{unseen:0}:pathname==='/api/work-overview'?{counts:{returned:0},items:[],byDepartment:[]}:pathname==='/api/access-assignments'?{items:identities.filter(item=>item.interactive!==false).map(item=>({...testActor(item.subject),subjectRef:item.subject,departmentManager:false,active:true,revision:1})),total:8}:null;
      return route.fulfill(data?{json:{data,queriedAt:new Date().toISOString()}}:{status:404,json:{errorCode:'NOT_FOUND'}});
    });
  }
  sessions.set(page,role?testActor(role):null);
}
