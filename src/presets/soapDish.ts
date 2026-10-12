// ---------------------------------------------------------------------------
// Soap dish — a part made to be milled from solid
// ---------------------------------------------------------------------------
//
// An 80 x 60 x 20 mm dish: a domed top with an oval well in it, a pocket in the
// underside with two ribs across it, and a drain joining the two. Nothing about
// it can be cut from one side. The well is on top and the pocket underneath,
// so it is the example for two-sided solid machining: side A cuts the top,
// the block is turned over on its registration pins, and side B cuts the
// underside.
//
// The ribs and the drain are off centre on purpose. A symmetric part comes
// out right even when side B is read back to front, so it cannot show the one
// mistake a two-sided job is most likely to make; this one can. Add Simulation
// in the Solid Machining dialog cuts both programs out of one block, and laid
// over the model, a drain or a rib in the wrong place is plain.
//
// It is OpenSCAD, compiled on load, so the variables at the top are sliders.
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';

const SOAP_DISH_SCAD = `// Soap dish, for two-sided solid machining. Millimetres.
length = 80; // [50:5:120]
width = 60; // [40:5:90]
height = 20; // [12:1:30]
corner_r = 12; // [4:1:20]
dish_depth = 8; // [3:1:12]
pocket_depth = 6; // [2:1:10]
rib_w = 5; // [3:1:10]
drain_r = 4; // [2:0.5:8]
drain_x = 7; // [-15:1:15]
drain_y = 4; // [-10:1:10]

module rrect(l, w, r, h) {
  hull() for (sx=[-1,1], sy=[-1,1]) translate([sx*(l/2-r), sy*(w/2-r), 0]) cylinder(r=r, h=h, $fn=48);
}

scale([0.001,0.001,0.001]) translate([0,0,-height/2]) difference() {
  intersection() {
    rrect(length, width, corner_r, height + 5);
    translate([0,0,height - 75*0.42]) scale([1, 0.8, 0.42]) sphere(r=75, $fn=91);
  }
  // oval dish in the top
  translate([0,0,height]) scale([28, 19, dish_depth]) sphere(r=1, $fn=64);
  // pocket in the underside, leaving two ribs across it (deliberately asymmetric)
  difference() {
    translate([0,0,-1]) rrect(length-16, width-16, corner_r-6, pocket_depth+1);
    for (x=[-17,20]) translate([x-rib_w/2, -width/2-1, -2]) cube([rib_w, width+2, pocket_depth+3]);
  }
  // drain hole joining the dish to the pocket, off centre
  translate([drain_x,drain_y,-1]) cylinder(r=drain_r, h=height+2, $fn=37);
}
`;

export const soapDishPreset: SceneGraph = {
  nodes: [
    {
      id: 'soap_dish',
      name: 'soap_dish',
      type: 'body',
      // Centred on its own height, so 10 mm up sits it on the ground.
      pos: [0, 0, 0.01],
      joints: [],
      // The mesh is filled in by the OpenSCAD auto-compile on load.
      geoms: [{ name: 'soap_dish_mesh', type: 'mesh', size: [1], dynamic: true, rgba: [0.78, 0.8, 0.83, 1] }],
      scad: SOAP_DISH_SCAD,
      children: [],
    },
  ],
};
