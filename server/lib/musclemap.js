'use strict';
// Which tracked muscle each region of the body-map artwork (lib/bodymap.js) belongs to. It is read by
// the browser's muscle card AND by the hub when it colours the watch's figures, so it lives here, once:
// two copies of a mapping like this drift, and the same region then shows a different muscle's colour
// on the wrist than on the wall. Several asset ids do not mean what they say (`abs-upper` is the flank,
// `lats-upper` is the rear delt); the mapping, not the id, is the truth.
function muscleForId(id){
 if(id.indexOf('delt-front')===0)return'front_delts';   // inner lobe of the cap
 if(id.indexOf('delt-side')===0)return'side_delts';     // outer lobe of the cap
 if(id.indexOf('shoulder-front')===0)return'upper_traps'; // high sliver by the neck/clavicle
 if(id.indexOf('deltoid-rear')===0)return'side_delts'; // the tiny lateral-edge sliver on the back = side delt wrap
 if(id.indexOf('biceps')===0)return'biceps';
 if(id.indexOf('forearm')===0)return'forearms';
 if(id.indexOf('chest-upper')===0)return'upper_chest';
 if(id.indexOf('chest-lower')===0)return'lower_chest';
 if(id.indexOf('abs-upper')===0)return'obliques'; // asset's "abs-upper" is actually the side flanks = obliques
 if(id.indexOf('abs-')===0)return'abs';            // abs-lower = central lower rectus
 if(id.indexOf('obliques')===0)return'abs';        // asset's "obliques" id is the central six-pack = rectus abdominis
 if(id.indexOf('serratus')===0)return'abs';        // serratus lumped into abs (no dedicated exercise tracked)
 if(id.indexOf('traps-upper')===0)return'upper_traps';
 if(id.indexOf('traps-mid')===0||id.indexOf('traps-lower')===0)return'mid_back';
 if(id.indexOf('lats-upper')===0)return'rear_delts'; // the big upper-back chevron = rear delts
 if(id.indexOf('lats-')===0)return'lats';
 if(id.indexOf('triceps-long')===0)return'triceps_long';
 if(id.indexOf('triceps-lateral')===0)return'triceps_lateral';
 if(id.indexOf('triceps-front')===0)return'triceps_lateral'; // outer sliver of the front upper arm (split off biceps)
 if(id.indexOf('quads')===0)return'quads';
 if(id.indexOf('gluteus')===0)return'glutes';
 if(id.indexOf('calves')===0)return'gastrocnemius';
 if(id.indexOf('tibialis')===0)return'gastrocnemius';
 if(id.indexOf('hamstrings')===0)return'hamstrings';
 if(id.indexOf('lower-back')===0)return'erectors';
 if(id.indexOf('adductors')===0)return'adductors';
 if(id.indexOf('hip-flexor')===0)return'hip_flexors';
 return null;
}

module.exports = { muscleForId };
