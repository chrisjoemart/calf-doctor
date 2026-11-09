import { parseUtterance, isYes, isNo } from '../src/voice.js';
import { analyze } from '../src/protocol.js';
import { computeReport } from '../src/reports.js';
const crew=[{email:'jake@x',name:'Jake'},{email:'wyatt@x',name:'Wyatt Smith'}];
const ctx={colors:['blue','green'],crew};
const cases = [
 'blue 42 103.3',
 'blue 42 104.1 draxxin',
 'Blue 4951, Draxxin, 104.0',
 'green 7 one oh four point two baytril pulled by jake',
 'blue forty two 105 point 1 HR two respiratory',
 'blue 42 103 3',
 'blue 12 bull castration 102.8',
 'blue 88 bloat tube 101.9',
 'blue 42 dead wolf',
 'blue 42 died sickness',
 'blue 42 sick 104.5 drax',
 'Blue 103 104.2 nuflor',
 'blew 15 104 drax wyatt',
 'pink eye blue 33 102.5 LR1',
 'blue42 104.6 drax note limping on left front',
 'blue 42 1038 drax',
];
for (const c of cases) { const p=parseUtterance(c,ctx); console.log(c.padEnd(52), '=>', JSON.stringify({c:p.tagColor,n:p.tagNum,t:p.temp,tr:p.treatment,d:p.diagnosis,cause:p.cause,death:p.isDeath,by:p.pulledBy,notes:p.notes,auto:p.autoCNT})); }
console.log('yes', isYes('yes'), isYes('Yeah save it'), isNo('no'), isYes('no'));
const h=[{kind:'pull',treatment:'HR1 Draxxin',at:1}];
console.log(JSON.stringify(analyze(h,{kind:'pull',temp:104.5,treatment:'HR1 Draxxin',diagnosis:'Respiratory'})));
console.log(JSON.stringify(analyze([],{kind:'pull',temp:103.1,treatment:'HR1 Draxxin',diagnosis:''})));
console.log(JSON.stringify(analyze([],{kind:'pull',temp:104.1,treatment:'Check No Treatment',diagnosis:''})));
console.log(JSON.stringify(analyze([{kind:'death',at:1}],{kind:'pull',temp:104.1,treatment:'',diagnosis:''})));
const E=(id,tag,at,by,tr,kind='pull',cause='')=>({id,tagKey:tag,at,pulledBy:by,treatment:tr,kind,cause,location:'L'});
const ents=[E(1,'a',1,'jake','HR1 Draxxin'),E(2,'a',2,'wyatt','HR2 Baytril'),E(3,'b',1,'wyatt','Check No Treatment'),E(4,'b',3,'jake','HR1 Draxxin'),E(5,'b',5,'','','death','Sickness'),E(6,'c',1,'jake','HR1 Draxxin'),E(7,'c',2,'','','death','Wolf')];
const r=computeReport(ents);
console.log([...r.cowboys.entries()].map(([k,v])=>k+':'+JSON.stringify(v)).join('\n'));
