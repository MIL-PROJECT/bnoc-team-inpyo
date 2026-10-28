import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import type { NoticeBodyDocument } from '../types';

const colors = ['default','#1d4ed8','#b91c1c','#166534'] as const;
type Run = NoticeBodyDocument['blocks'][number]['runs'][number];

export function plainNoticeDocument(body: string): NoticeBodyDocument {
  return { version:1,blocks:(body ? body.split('\n') : ['']).map(text=>({type:'paragraph' as const,runs:[{text}]})) };
}
export function plainNoticeText(document: NoticeBodyDocument): string {
  return document.blocks.map(block=>block.runs.map(run=>run.text).join('')).join('\n');
}
function styleOf(run: Run) {
  return { fontWeight:run.bold?'700':undefined,textDecoration:run.underline?'underline':undefined,fontSize:run.size?`${run.size}px`:undefined,color:run.color && run.color!=='default'?run.color:undefined };
}
function renderBlocks(document: NoticeBodyDocument, render: (block: NoticeBodyDocument['blocks'][number],key:string)=>ReactNode) {
  const output: ReactNode[]=[];
  for(let index=0;index<document.blocks.length;) {
    const block=document.blocks[index];
    if(block.type==='listItem') {
      const list=block.list ?? 'bullet',items=[];
      while(index<document.blocks.length && document.blocks[index].type==='listItem' && document.blocks[index].list===list) items.push(render(document.blocks[index++],`${list}-${index}`));
      output.push(list==='ordered'?<ol key={`ordered-${index}`}>{items}</ol>:<ul key={`bullet-${index}`}>{items}</ul>);
    } else output.push(render(document.blocks[index],`paragraph-${index++}`));
  }
  return output;
}
export function NoticeBodyContent({ document, body }: { document?: NoticeBodyDocument | null; body:string }) {
  if(!document) return <div className="notice-content pre">{body}</div>;
  return <div className="notice-content">{renderBlocks(document,(block,key)=>{
    const content=block.runs.map((run,index)=><span key={`${key}-${index}`} style={styleOf(run)}>{run.text}</span>);
    return block.type==='listItem'?<li key={key}>{content}</li>:<p key={key}>{content}</p>;
  })}</div>;
}

function directBlock(node: Node, root: HTMLElement): HTMLElement | null {
  let current:Node=node;
  while(current.parentNode && current.parentNode!==root) current=current.parentNode;
  return current.parentNode===root && current instanceof HTMLElement ? current : null;
}
function readRuns(node: Node): Run[] {
  const runs:Run[]=[];
  const push=(text:string,style:{bold:boolean;underline:boolean;size?:16|20|24;color?:Run['color']})=>{
    if(!text) return;
    const previous=runs[runs.length-1];
    if(previous && previous.bold===style.bold && previous.underline===style.underline && previous.size===style.size && previous.color===style.color) previous.text+=text;
    else runs.push({text,...(style.bold?{bold:true}:{}),...(style.underline?{underline:true}:{}),...(style.size?{size:style.size}:{}),...(style.color?{color:style.color}:{})});
  };
  const walk=(child:Node, parent:{bold:boolean;underline:boolean;size?:16|20|24;color?:Run['color']})=>{
    if(child.nodeType===Node.TEXT_NODE) { push(child.textContent ?? '',parent);return; }
    if(!(child instanceof HTMLElement)) return;
    const bold=parent.bold || ['B','STRONG'].includes(child.tagName),underline=parent.underline || child.tagName==='U';
    const rawSize=child.style.fontSize?.replace('px','');const size=rawSize==='16'||rawSize==='20'||rawSize==='24'?Number(rawSize) as 16|20|24:parent.size;
    const rawColor=child.style.color?.replaceAll(' ','').toLowerCase();
    const normalizedColor=rawColor==='var(--color-text)'?'default':rawColor==='rgb(29,78,216)'?'#1d4ed8':rawColor==='rgb(185,28,28)'?'#b91c1c':rawColor==='rgb(22,101,52)'?'#166534':rawColor;
    const color=colors.find(value=>value===normalizedColor) ?? parent.color;
    const style={bold,underline,size,color};
    if(child.tagName==='BR') push('\n',style); else child.childNodes.forEach(grandchild=>walk(grandchild,style));
  };
  walk(node,{bold:false,underline:false});
  return runs.length?runs:[{text:''}];
}
export function serializeNoticeEditor(root:HTMLElement): NoticeBodyDocument {
  const blocks:NoticeBodyDocument['blocks']=[];
  root.childNodes.forEach(node=>{
    if(node instanceof HTMLElement && (node.tagName==='UL'||node.tagName==='OL')) {
      const list=node.tagName==='OL'?'ordered':'bullet';
      node.querySelectorAll(':scope > li').forEach(item=>blocks.push({type:'listItem',list,runs:readRuns(item)}));
    } else if(node instanceof HTMLElement && node.tagName==='LI') blocks.push({type:'listItem',list:'bullet',runs:readRuns(node)});
    else if(node instanceof HTMLElement && node.tagName==='BR') blocks.push({type:'paragraph',runs:[{text:''}]});
    else blocks.push({type:'paragraph',runs:readRuns(node)});
  });
  while(blocks.length>1) {
    const last=blocks.at(-1)!;
    if(last.type!=='paragraph' || last.runs.some(run=>run.text.length>0)) break;
    blocks.pop();
  }
  return {version:1,blocks:blocks.length?blocks:[{type:'paragraph',runs:[{text:''}]}]};
}
function appendRun(parent:HTMLElement,run:Run) {
  let node:Node=document.createTextNode(run.text);
  if(run.bold) { const strong=document.createElement('strong');strong.append(node);node=strong; }
  if(run.underline) { const underline=document.createElement('u');underline.append(node);node=underline; }
  if(run.size || (run.color && run.color!=='default')) { const span=document.createElement('span');if(run.size)span.style.fontSize=`${run.size}px`;if(run.color&&run.color!=='default')span.style.color=run.color;span.append(node);node=span; }
  parent.append(node);
}
export function writeNoticeEditor(root:HTMLElement,docModel:NoticeBodyDocument) {
  root.replaceChildren();
  for(let index=0;index<docModel.blocks.length;) {
    const block=docModel.blocks[index];
    if(block.type==='listItem') {
      const list=block.list==='ordered'?document.createElement('ol'):document.createElement('ul');
      while(index<docModel.blocks.length && docModel.blocks[index].type==='listItem' && docModel.blocks[index].list===block.list) {
        const item=document.createElement('li');docModel.blocks[index++].runs.forEach(run=>appendRun(item,run));list.append(item);
      }
      root.append(list);
    } else {
      const paragraph=document.createElement('p');block.runs.forEach(run=>appendRun(paragraph,run));root.append(paragraph);index++;
    }
  }
  if(!root.childNodes.length) root.append(document.createElement('p'));
}
function applyStyle(root:HTMLElement,property:'fontSize'|'color',value:string,savedRange:Range|null) {
  const selection=window.getSelection();
  if(!selection) return false;
  const range=savedRange ?? (selection.rangeCount ? selection.getRangeAt(0) : null);
  if(!range || range.collapsed) return false;
  if(!root.contains(range.commonAncestorContainer) || directBlock(range.startContainer,root)!==directBlock(range.endContainer,root)) return false;
  const fragment=range.extractContents(),span=document.createElement('span');
  fragment.querySelectorAll<HTMLElement>('[style]').forEach(element=>{element.style[property]='';});
  if(property==='fontSize' && value) span.style.fontSize=`${value}px`;
  if(property==='color') span.style.color=value==='default'?'var(--color-text)':value;
  span.append(fragment);range.insertNode(span);selection.removeAllRanges();const next=document.createRange();next.selectNodeContents(span);selection.addRange(next);
  return true;
}
export function NoticeBodyEditor({ value,onChange,resetKey,error,errorId='notice-body-error' }: { value:NoticeBodyDocument;onChange:(document:NoticeBodyDocument)=>void;resetKey:number;error?:string;errorId?:string }) {
  const editor=useRef<HTMLDivElement>(null);
  const savedRange=useRef<Range|null>(null);
  const initialize=()=>{if(editor.current)writeNoticeEditor(editor.current,value);};
  useEffect(initialize,[resetKey]);
  const save=()=>{if(editor.current)onChange(serializeNoticeEditor(editor.current));};
  const rememberSelection=()=>{
    const root=editor.current,selection=window.getSelection();
    if(root && selection?.rangeCount) {
      const range=selection.getRangeAt(0);
      if(root.contains(range.commonAncestorContainer))savedRange.current=range.cloneRange();
    }
  };
  const action=(kind:'bold'|'underline'|'bullet'|'ordered'|'size'|'color',value?:string)=>{
    const root=editor.current;if(!root)return;
    root.focus();
    if(kind==='size'||kind==='color') {
      const ok=applyStyle(root,kind==='size'?'fontSize':'color',value??'',savedRange.current);
      if(!ok) return;
      rememberSelection();
    } else document.execCommand(kind==='bullet'?'insertUnorderedList':kind==='ordered'?'insertOrderedList':kind,false);
    rememberSelection();
    save();
  };
  const preserve=(event:MouseEvent<HTMLButtonElement>)=>{rememberSelection();event.preventDefault();};
  return <section className="notice-editor" aria-label="공지 본문 편집">
    <div className="notice-toolbar" aria-label="본문 서식 도구">
      <button type="button" onMouseDown={preserve} onClick={()=>action('bold')} aria-label="굵게"><strong>B</strong></button>
      <button type="button" onMouseDown={preserve} onClick={()=>action('underline')} aria-label="밑줄"><u>U</u></button>
      {[16,20,24].map(size=><button type="button" key={size} onMouseDown={preserve} onClick={()=>action('size',String(size))} aria-label={`글자 크기 ${size}`}>{size}px</button>)}
      <label className="field"><span>글자색</span><select aria-label="글자색" defaultValue="default" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={event=>action('color',event.target.value)}>{colors.map(color=><option key={color} value={color}>{color==='default'?'기본색':color==='#1d4ed8'?'파랑':color==='#b91c1c'?'빨강':'초록'}</option>)}</select></label>
      <button type="button" onMouseDown={preserve} onClick={()=>action('bullet')} aria-label="글머리 목록">• 목록</button>
      <button type="button" onMouseDown={preserve} onClick={()=>action('ordered')} aria-label="번호 목록">번호 목록</button>
    </div>
    <div ref={editor} className="notice-editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="내용" aria-multiline="true" aria-invalid={!!error} aria-describedby={error?errorId:undefined} onInput={save} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBlur={rememberSelection} onPaste={event=>{event.preventDefault();const text=event.clipboardData.getData('text/plain');document.execCommand('insertText',false,text);save();}} />
    <small className="field-hint">서식을 적용할 글자를 선택한 뒤 도구를 누르세요. 붙여넣기는 일반 텍스트로 들어갑니다.</small>
  </section>;
}
