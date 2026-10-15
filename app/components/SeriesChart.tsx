'use client';
import {useId,useState} from 'react';
import {download,exportSeries,number} from '../../lib/client-utils';
const COLORS=['#09676d','#bf7153','#43526c','#a99574'];
export default function SeriesChart({series,years=5,compact=false,title}:{series:any[],years?:number,compact?:boolean,title?:string}){
const id=useId().replace(/[^a-zA-Z0-9]/g,'');const[hover,setHover]=useState<number|null>(null);
const valid=series.filter(s=>s?.points?.some((p:any)=>p.value!=null));
const allPeriods=Array.from(new Set<string>(valid.flatMap(s=>s.points.map((p:any)=>p.period)))).sort();
const endYear=Number(allPeriods.at(-1)?.slice(0,4)||new Date().getFullYear());
const periods=allPeriods.filter(p=>Number(p.slice(0,4))>=endYear-years+1);
const rows=periods.map(period=>({period,values:valid.map(s=>s.points.find((p:any)=>p.period===period)?.value??null)}));
const values=rows.flatMap(r=>r.values).filter(v=>typeof v==='number'&&Number.isFinite(v));
if(!values.length)return <div className="empty-note">尚无可展示的同口径历史序列。</div>;
const lo=Math.min(...values),hi=Math.max(...values),pad=(hi-lo)*.14||Math.abs(hi)*.05||1,min=lo-pad,max=hi+pad;
const W=780,H=compact?180:310,L=54,R=20,T=18,B=35;const x=(i:number)=>L+(W-L-R)*(rows.length===1?.5:i/(rows.length-1));const y=(v:number)=>T+(H-T-B)*(1-(v-min)/(max-min));
const index=hover==null?rows.length-1:Math.max(0,Math.min(hover,rows.length-1));const row=rows[index];
function saveSvg(){const el=document.getElementById('chart-'+id);if(!el)return;const txt=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H+90}"><rect width="100%" height="100%" fill="#fff1e5"/><text x="20" y="24" font-size="16" fill="#252d30">${esc(title||valid[0].title)}</text><g transform="translate(0 36)">${el.innerHTML}</g><text x="20" y="${H+66}" font-size="10" fill="#68645e">${esc(valid.map(s=>s.provider).join(' / '))} · ${esc(valid[0].unit||'')} · 数据截至 ${esc(rows.at(-1)?.period||'')}</text></svg>`;download((title||'市场走势')+'.svg',txt,'image/svg+xml');}
return <div className={'series-chart '+(compact?'compact':'')}><div className="chart-readout"><span>{row.period}</span>{valid.map((s,i)=><span key={s.id} style={{color:COLORS[i%4]}}><i style={{background:COLORS[i%4]}}/>{s.grade&&valid.length>1?s.grade+'级':s.provider} <b>{number(row.values[i])}</b></span>)}</div><svg id={'chart-'+id} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={(title||valid[0].title)+'历史走势图'} onMouseMove={e=>{const rect=e.currentTarget.getBoundingClientRect();const px=(e.clientX-rect.left)/rect.width*W;setHover(Math.round((px-L)/(W-L-R)*(rows.length-1)));}} onMouseLeave={()=>setHover(null)}>
{[0,1,2,3,4].map(k=>{const v=min+(max-min)*k/4;return <g key={k}><line x1={L} x2={W-R} y1={y(v)} y2={y(v)} stroke="#dbd0c4" strokeDasharray="3 4"/><text x={L-9} y={y(v)+4} fontSize="11" fill="#716a61" textAnchor="end">{number(v,0)}</text></g>;})}
{valid.map((s,si)=>{let path='';let started=false;rows.forEach((r,i)=>{const v=r.values[si];if(v==null){started=false;return;}path+=(started?'L':'M')+x(i).toFixed(2)+' '+y(v).toFixed(2)+' ';started=true;});return <g key={s.id}><path d={path} fill="none" stroke={COLORS[si%4]} strokeWidth={compact?2.2:2.7} strokeLinejoin="round"/>{rows.length<6&&rows.map((r,i)=>r.values[si]!=null&&<circle key={i} cx={x(i)} cy={y(r.values[si])} r="3.5" fill={COLORS[si%4]}/>)}</g>;})}
{Array.from(new Set([0,Math.floor((rows.length-1)/3),Math.floor((rows.length-1)*2/3),rows.length-1])).map(i=><text key={i} x={x(i)} y={H-9} textAnchor="middle" fontSize="11" fill="#716a61">{rows[i]?.period}</text>)}
{hover!==null&&<line x1={x(index)} x2={x(index)} y1={T} y2={H-B} stroke="#b6aca0"/>}{hover!==null&&valid.map((s,i)=>row.values[i]!=null&&<circle key={s.id} cx={x(index)} cy={y(row.values[i])} r="4" fill={COLORS[i%4]} stroke="#fff1e5" strokeWidth="2"/>)}
</svg>{!compact&&<div className="chart-footer"><span>{valid[0].unit} · 缺期保留，不插值</span><div><button onClick={saveSvg}>导出 SVG</button><button onClick={()=>exportSeries(valid[0])}>下载 CSV</button></div></div>}</div>;
}
function esc(s:string){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
