import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { NoticeBodyDocument } from '../types';
import './noticeFeedback.css';

const colors = ['default','#1d4ed8','#b91c1c','#166534'] as const;
const fonts = { 'sans-serif':'고딕', serif:'명조', monospace:'고정폭' } as const;
type Run = NoticeBodyDocument['blocks'][number]['runs'][number];

export function plainNoticeDocument(body: string): NoticeBodyDocument {
  return { version:1,blocks:(body ? body.split('\n') : ['']).map(text=>({type:'paragraph' as const,runs:[{text}]})) };
}
export function plainNoticeText(document: NoticeBodyDocument): string {
  return document.blocks.map(block=>block.runs.map(run=>run.text).join('')).join('\n');
}
function styleOf(run: Run) {
  return { fontWeight:run.bold?'700':undefined,fontStyle:run.italic?'italic':undefined,fontFamily:run.font,textDecoration:run.underline?'underline':undefined,fontSize:run.size?`${run.size}px`:undefined,color:run.color && run.color!=='default'?run.color:undefined };
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

function readRuns(node: Node): Run[] {
  const runs:Run[]=[];
  type Style = {bold:boolean;italic:boolean;underline:boolean;size?:number;font?:Run['font'];color?:Run['color']};
  const push=(text:string,style:Style)=>{
    if(!text) return;
    const previous=runs[runs.length-1];
    if(previous && Boolean(previous.bold)===style.bold && Boolean(previous.italic)===style.italic && Boolean(previous.underline)===style.underline && previous.size===style.size && previous.font===style.font && previous.color===style.color) previous.text+=text;
    else runs.push({text,...(style.bold?{bold:true}:{}),...(style.italic?{italic:true}:{}),...(style.underline?{underline:true}:{}),...(style.size?{size:style.size}:{}),...(style.font?{font:style.font}:{}),...(style.color?{color:style.color}:{})});
  };
  const walk=(child:Node, parent:Style)=>{
    if(child.nodeType===Node.TEXT_NODE) { push(child.textContent ?? '',parent);return; }
    if(!(child instanceof HTMLElement)) return;
    const bold=parent.bold || ['B','STRONG'].includes(child.tagName),italic=parent.italic || ['I','EM'].includes(child.tagName),underline=parent.underline || child.tagName==='U';
    const rawSize=Number(child.style.fontSize?.replace('px',''));const size=Number.isInteger(rawSize)&&rawSize>=12&&rawSize<=48?rawSize:parent.size;
    const font=Object.keys(fonts).find(value=>value===child.style.fontFamily) as Run['font'] ?? parent.font;
    const rawColor=child.style.color?.replaceAll(' ','').toLowerCase();
    const normalizedColor=rawColor==='var(--color-text)'?'default':rawColor==='rgb(29,78,216)'?'#1d4ed8':rawColor==='rgb(185,28,28)'?'#b91c1c':rawColor==='rgb(22,101,52)'?'#166534':rawColor;
    const color=colors.find(value=>value===normalizedColor) ?? parent.color;
    const style={bold,italic,underline,size,font,color};
    if(child.tagName==='BR') push('\n',style); else child.childNodes.forEach(grandchild=>walk(grandchild,style));
  };
  walk(node,{bold:false,italic:false,underline:false});
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
  if(run.italic) { const italic=document.createElement('em');italic.append(node);node=italic; }
  if(run.underline) { const underline=document.createElement('u');underline.append(node);node=underline; }
  if(run.size || run.font || run.color) { const span=document.createElement('span');if(run.size)span.style.fontSize=`${run.size}px`;if(run.font)span.style.fontFamily=run.font;if(run.color)span.style.color=run.color==='default'?'var(--color-text)':run.color;span.append(node);node=span; }
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
function applyStyle(root:HTMLElement,property:'fontSize'|'fontFamily'|'color',value:string,savedRange:Range|null) {
  const selection=window.getSelection();
  if(!selection) return false;
  const range=savedRange ?? (selection.rangeCount ? selection.getRangeAt(0) : null);
  if(!range || range.collapsed) return false;
  if(!root.contains(range.commonAncestorContainer)) return false;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts:{node:Text;start:number;end:number}[]=[];
  while(walker.nextNode()) {
    const node=walker.currentNode as Text;
    if(!range.intersectsNode(node)) continue;
    const start=node===range.startContainer?range.startOffset:0,end=node===range.endContainer?range.endOffset:node.length;
    if(end>start)parts.push({node,start,end});
  }
  const spans:HTMLElement[]=[];
  for(const {node,start,end} of parts) {
    const part=document.createRange();part.setStart(node,start);part.setEnd(node,end);
    const span=document.createElement('span');
    span.style[property]=property==='fontSize'?`${value}px`:property==='color'&&value==='default'?'var(--color-text)':value;
    span.append(part.extractContents());part.insertNode(span);spans.push(span);
  }
  if(!spans.length)return false;
  selection.removeAllRanges();const next=document.createRange();next.setStart(spans[0],0);next.setEnd(spans.at(-1)!,spans.at(-1)!.childNodes.length);selection.addRange(next);
  return true;
}
export function NoticeBodyEditor({ value,onChange,resetKey,error,errorId='notice-body-error' }: { value:NoticeBodyDocument;onChange:(document:NoticeBodyDocument)=>void;resetKey:number;error?:string;errorId?:string }) {
  const editor=useRef<HTMLDivElement>(null);
  const savedRange=useRef<Range|null>(null);
  const [size,setSize]=useState('16');
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
  const action=(kind:'bold'|'italic'|'underline'|'bullet'|'ordered'|'size'|'font'|'color',value?:string)=>{
    const root=editor.current;if(!root)return;
    root.focus();
    if(kind==='size'||kind==='color'||kind==='font') {
      if(kind==='size'&&(!Number.isInteger(Number(value))||Number(value)<12||Number(value)>48))return;
      const ok=applyStyle(root,kind==='size'?'fontSize':kind==='font'?'fontFamily':'color',value??'',savedRange.current);
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
      <button type="button" onMouseDown={preserve} onClick={()=>action('italic')} aria-label="기울임"><em>I</em></button>
      <button type="button" onMouseDown={preserve} onClick={()=>action('underline')} aria-label="밑줄"><u>U</u></button>
      <label className="field"><span>글꼴</span><select aria-label="글꼴" defaultValue="sans-serif" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={event=>action('font',event.target.value)}>{Object.entries(fonts).map(([font,label])=><option key={font} value={font}>{label}</option>)}</select></label>
      <label className="field"><span>글자 크기</span><input type="number" aria-label="글자 크기" min={12} max={48} step={1} value={size} onFocus={rememberSelection} onChange={event=>setSize(event.target.value)}/></label><button type="button" onMouseDown={preserve} onClick={()=>action('size',size)}>크기 적용</button>
      {[16,20,24].map(size=><button type="button" key={size} onMouseDown={preserve} onClick={()=>action('size',String(size))} aria-label={`글자 크기 ${size}`}>{size}px</button>)}
      <label className="field"><span>글자색</span><select aria-label="글자색" defaultValue="default" onMouseDown={rememberSelection} onFocus={rememberSelection} onChange={event=>action('color',event.target.value)}>{colors.map(color=><option key={color} value={color}>{color==='default'?'기본색':color==='#1d4ed8'?'파랑':color==='#b91c1c'?'빨강':'초록'}</option>)}</select></label>
      <button type="button" onMouseDown={preserve} onClick={()=>action('bullet')} aria-label="글머리 목록">• 목록</button>
      <button type="button" onMouseDown={preserve} onClick={()=>action('ordered')} aria-label="번호 목록">번호 목록</button>
    </div>
    <div ref={editor} className="notice-editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="내용" aria-multiline="true" aria-invalid={!!error} aria-describedby={error?errorId:undefined} onInput={save} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onBlur={rememberSelection} onPaste={event=>{event.preventDefault();const text=event.clipboardData.getData('text/plain');document.execCommand('insertText',false,text);save();}} />
    <small className="field-hint">서식을 적용할 글자를 선택한 뒤 도구를 누르세요. 붙여넣기는 일반 텍스트로 들어갑니다.</small>
  </section>;
}
