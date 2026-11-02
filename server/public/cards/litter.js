// Litter-Robot status card.
import { hueColor } from '../shared.js';

function litterColor(v){return v==null?'#8b96a5':hueColor((90-v)/20);}  // 90% green -> 70% red
function drawerColor(v){return v==null?'#8b96a5':hueColor((v-75)/20);}  // 75% green -> 95% red

export function render(s){
 const L=s.litter||{};
 // The state, its label and its colour are the server's: the robot's own status says nothing about
 // a queued clean, a lockout, or a watcher that stopped reporting. See buildLitter in lib/litter.js.
 // Thin horizontal home-status strip: one device = a row of inline chips. Leaves room for more
 // device chip-groups later (e.g. a pet feeder) — just append another .devchips block.
 const chip=(label,val,col)=>'<span class=devchip><span class=dc-l>'+label+'</span>'+
   '<span class=dc-v style="color:'+col+'">'+val+'</span></span>';
 const el=document.getElementById('litter'); if(!el)return;  // a surface without the tile (the phone's home page)
 el.innerHTML=
  '<div class=devstrip>'+
   '<div class=devchips>'+
     '<img class=devicon src="/litter-robot.png" alt="Litter-Robot">'+
     chip('','<span class=dot style="background:'+(L.color||'#8b96a5')+'"></span>'+(L.label||'—'),'#e6eaf0')+
     chip('Used',(L.used_ago||'—'),'#e6eaf0')+
     chip('Litter',(L.litter_level_pct!=null?L.litter_level_pct+'%':'—'),litterColor(L.litter_level_pct))+
     chip('Drawer',(L.waste_drawer_pct!=null?L.waste_drawer_pct+'%':'—'),drawerColor(L.waste_drawer_pct))+
   '</div>'+
  '</div>';
}
