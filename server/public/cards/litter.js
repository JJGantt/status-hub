// Litter-Robot status card.
import { hueColor } from '../shared.js';

const STATUS_LABEL={READY:'Ready',CLEAN_CYCLE:'Cleaning',CAT_SENSOR_INTERRUPTED:'Stuck (auto-resuming)',
 PAUSED:'Paused',CAT_DETECTED:'Cat detected',CAT_SENSOR_TIMING:'Waiting (post-cat)',
 CLEAN_CYCLE_COMPLETE:'Cycle complete',DRAWER_FULL:'Drawer full!',OFFLINE:'Offline',OFF:'Off'};
const STATUS_COLOR={READY:'#3b82f6',CLEAN_CYCLE:'#eab308',CAT_SENSOR_INTERRUPTED:'#f97316',
 PAUSED:'#f97316',DRAWER_FULL:'#ef4444',OFFLINE:'#ef4444',OFF:'#566'};
function litterColor(v){return v==null?'#8b96a5':hueColor((90-v)/20);}  // 90% green -> 70% red
function drawerColor(v){return v==null?'#8b96a5':hueColor((v-75)/20);}  // 75% green -> 95% red

export function render(s){
 const L=s.litter||{};const st=L.status||'OFFLINE';
 // Thin horizontal home-status strip: one device = a row of inline chips. Leaves room for more
 // device chip-groups later (e.g. a pet feeder) — just append another .devchips block.
 const chip=(label,val,col)=>'<span class=devchip><span class=dc-l>'+label+'</span>'+
   '<span class=dc-v style="color:'+col+'">'+val+'</span></span>';
 document.getElementById('litter').innerHTML=
  '<div class=devstrip>'+
   '<div class=devchips>'+
     '<img class=devicon src="/litter-robot.png" alt="Litter-Robot">'+
     chip('','<span class=dot style="background:'+(STATUS_COLOR[st]||'#8b96a5')+'"></span>'+(STATUS_LABEL[st]||st),'#e6eaf0')+
     chip('Litter',(L.litter_level_pct!=null?L.litter_level_pct+'%':'—'),litterColor(L.litter_level_pct))+
     chip('Drawer',(L.waste_drawer_pct!=null?L.waste_drawer_pct+'%':'—'),drawerColor(L.waste_drawer_pct))+
   '</div>'+
  '</div>';
}
