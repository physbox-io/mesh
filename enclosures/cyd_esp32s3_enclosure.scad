// ============================================================================
// Enclosure for Hosyond ESP32-S3 CYD (Cheap Yellow Display)
// Portrait orientation, snap-fit lid + box (4 cantilever tabs, no screws).
//
// ASSUMPTIONS (verify against your physical board before printing):
//   - Board is 8mm of bare PCB above the screen (board_top_gap), then the 69mm
//     screen, then whatever remains of the 15mm board/screen length difference
//     at the bottom for USB-C + GPIO header (board_l - board_top_gap - screen_l)
//   - 4 mounting holes at the board's corners, positioned relative to the lid's
//     screen window: board_hole_offset_x (4mm) inset from the window's left/right
//     edges, board_hole_offset_y (4mm) out beyond the window's top/bottom edges
//
// Render one part at a time: set `part` below to "box", "lid", or "both"
// (both = side-by-side preview, not print-safe as one plate)
// ============================================================================

part = "both"; // "box" | "lid" | "both"

// ---- Board & display -------------------------------------------------------
board_l = 86.00;        // board length (portrait long axis)
board_w = 50.00;        // board width
screen_l = 74.20;       // screen length (69.20 + 5mm safety padding)
screen_w = 53.00;       // screen width (50.00 + 3mm safety padding)
comfort = 15;           // extra room added to interior length & width

board_top_gap = 8.22;   // bare PCB between the board's top edge and the screen's top edge
                        // (remaining board_l - board_top_gap - screen_l sits below the screen)

board_hole_offset_x = 4; // mounting hole inset from the window's left/right (longer) edges
board_hole_offset_y = 4; // mounting hole offset out beyond the window's top/bottom (shorter) edges
board_screw_d = 3.20;   // screw goes straight through the board into a blind hole in the lid (M3 screw size)
board_hole_depth = 2;   // blind depth into the lid (lid_h - 1mm skin, keeps the front face intact)

// ---- Enclosure shell --------------------------------------------------------
wall = 2.5;                       // side wall thickness
interior_l = board_l + comfort;   // 99
interior_w = board_w + comfort;   // 64
outer_l = interior_l + 2*wall;    // 104  (portrait long axis)
outer_w = interior_w + 2*wall;    // 69   (portrait short axis)

total_depth = 45;   // overall assembled depth (box_h + lid_h)
lid_h = 3;           // lid = thin front bezel with screen window; board sits flush against its inner face
box_h = total_depth - lid_h; // 42, deep back cover

// ---- Snap-fit tabs (lid <-> box, replaces screws) ---------------------------
// 4 cantilever tabs on the lid (2 per long/side wall) reach into the box past
// its inner wall surface and hook into a matching notch recessed into that
// wall. tab_gap must be < hook_d so the hook actually protrudes past the wall's
// inner face at rest - that's what makes it require force (and flex) to seat,
// giving the "click" instead of just sliding freely.
tab_width = 8;           // flexible arm width, along the wall
tab_thickness = 1.6;     // base arm thickness (the dimension that flexes)
tab_tip_thickness = 1.0; // tip thickness (tapered for strength and flexibility)
tab_length = 6;          // how far the tab reaches past the lid's inner face into the box
tab_gap = 0.2;           // clearance between the tab's rest position and the box's inner wall
hook_d = 0.8;            // how far the hook protrudes past the tab's rest face into the notch
hook_h = 1.5;            // height of the hook engagement feature at the tab's tip
notch_h = hook_h + 1;    // matching notch height in the box wall - a bit taller for easy engagement
tab_y = [30, 74];        // 2 tab positions along the box's length, mirrored on both side walls
tab_chamfer_w = 1.2;     // chamfer width at root (prevents snapping off)
tab_chamfer_h = 1.2;     // chamfer height at root (prevents snapping off)

// ---- Screen window (lid) -----------------------------------------------------
window_margin = 2;       // bezel overlap over screen edge, per side

// ---- Antenna holes (box, top wall = far end from USB/GPIO) ------------------
whip_hole_d = 7;         // small whip antenna (SMA-style) hole
phone_hole_d = 13;       // solid plastic cellphone-style antenna base
antenna_hole_margin = 23; // inset from the box's side edges

// ---- USB-C / GPIO slot (box, bottom wall) ------------------------------------
usb_slot_w = 32;
usb_slot_h = 14;
usb_slot_r = 4;          // corner rounding
usb_slot_z_from_top = 10; // slot center distance down from the box's open (lid) edge

// ---- Derived board placement (centered in interior footprint) ---------------
board_x0 = wall + (interior_w - board_w) / 2;
board_y0 = wall + (interior_l - board_l) / 2;

// ============================================================================
// Helpers
// ============================================================================

module rounded_slot(width, height, thickness, r) {
    // cross-section (width x height, rounded) lies in the XZ plane at the
    // origin, extruded back through `thickness` along -Y - for cutting a
    // rounded slot straight through a wall of the given thickness
    rotate([90, 0, 0])
        linear_extrude(height = thickness)
            hull() {
                for (dx = [r, width-r])
                    for (dz = [r, height-r])
                        translate([dx, dz]) circle(r=r, $fn=32);
            }
}

// ============================================================================
// BOX (deep back cover: walls + floor + antenna holes + USB/GPIO slot + snap notches)
// ============================================================================
module box_with_antenna_holes() {
    antenna_x1 = antenna_hole_margin;               // whip, near left wall
    antenna_x2 = outer_w - antenna_hole_margin;     // phone-style, near right wall

    difference() {
        cube([outer_w, outer_l, box_h]);
        // hollow interior, leaving floor + walls (open top, no ceiling)
        translate([wall, wall, wall])
            cube([outer_w - 2*wall, outer_l - 2*wall, box_h]);

        // antenna holes - top wall (far end, y = outer_l)
        translate([antenna_x1, outer_l - wall - 1, box_h/2])
            rotate([-90,0,0])
                cylinder(h=wall+2, d=whip_hole_d, $fn=32);
        translate([antenna_x2, outer_l - wall - 1, box_h/2])
            rotate([-90,0,0])
                cylinder(h=wall+2, d=phone_hole_d, $fn=32);

        // USB-C / GPIO slot - bottom wall (near end, y = 0)
        translate([outer_w/2 - usb_slot_w/2, wall+1, box_h - usb_slot_z_from_top - usb_slot_h/2])
            rounded_slot(usb_slot_w, usb_slot_h, wall+2, usb_slot_r);

        // snap-fit notches in both side walls (see snap_tab for the matching lid hook)
        box_snap_notches();
    }
}

// Blind pockets recessed into the inner face of both side walls, one per tab_y
// position per side. notch_z is measured down from the box's open top edge, at
// the depth where each tab's hook sits once the lid is fully seated (tab_length
// past the lid's inner face, minus the hook's own height along the tab).
module box_snap_notches() {
    notch_depth = hook_d + 0.5;     // how far into the wall material the pocket cuts
    notch_width = tab_width + 1;    // a little clearance beyond the tab's own width
    notch_z = box_h - tab_length + hook_h/2; // hook center, translated into box-frame z

    for (side = [0, 1]) {
        wall_face_x = side == 0 ? wall : outer_w - wall; // inner wall surface
        cut_x0 = side == 0 ? wall_face_x - notch_depth : wall_face_x;
        for (ny = tab_y) {
            translate([cut_x0, ny - notch_width/2, notch_z - notch_h/2])
                cube([notch_depth, notch_width, notch_h]);
        }
    }
}

// ============================================================================
// LID (thin front bezel: screen window + blind M6 board mounting holes + snap
// tabs - board sits flush against the inner face, no standoff)
// ============================================================================
module lid() {
    screen_y0_local = board_l - board_top_gap - screen_l; // board_top_gap of bare PCB above the screen
    window_w = screen_w - 2*window_margin;
    window_l = screen_l - 2*window_margin;
    window_x0 = board_x0 + (board_w - window_w) / 2;
    window_y0 = board_y0 + screen_y0_local + window_margin;

    // board mounting hole positions, directly relative to the board boundaries
    // placed exactly 2mm inset from PCB edges to provide window clearance
    board_hole_x = [board_x0 + 2.00, board_x0 + board_w - 2.00];
    board_hole_y = [board_y0 + 2.00, board_y0 + board_l - 2.00];

    // board mounting holes are cut in an OUTER difference(), after the snap
    // tabs are unioned in, in case a tab and a board hole ever land close
    // enough for the tab's own solid body to partially fill a hole back in
    difference() {
        union() {
            difference() {
                cube([outer_w, outer_l, lid_h]);

                // screen window, full through-cut
                translate([window_x0, window_y0, -1])
                    cube([window_w, window_l, lid_h + 2]);
            }

            // snap-fit tabs reaching into the box (see box_snap_notches for the
            // matching notch) - 2 per side wall
            for (ny = tab_y) {
                snap_tab(wall, +1, ny);              // left wall: cavity increases with +x
                snap_tab(outer_w - wall, -1, ny);     // right wall: cavity increases with -x
            }
        }

        // board mounting screws - straight through the board's own holes into a
        // blind M6 hole bored directly into the lid (no standoff, board sits flush
        // against the inner face at z=lid_h)
        for (hx = board_hole_x)
            for (hy = board_hole_y)
                translate([hx, hy, lid_h - board_hole_depth])
                    cylinder(h=board_hole_depth+1, d=board_screw_d, $fn=32);
    }
}

// A single cantilever snap tab, extending from the lid's inner face (z=lid_h)
// further into the box by tab_length. wall_x is the box's inner wall surface
// x-position; dir is +1 if the box cavity is in the +x direction from wall_x
// (left wall) or -1 if it's in the -x direction (right wall). The arm sits
// tab_gap inside the cavity from the wall at rest; the hook on its outer face
// protrudes hook_d back toward the wall - since hook_d > tab_gap, the hook
// tip normally reaches past the wall's inner surface, so the tab must flex
// away from the wall to slide past it before snapping into the notch pocket.
module snap_tab(wall_x, dir, y_center) {
    arm_near_x = wall_x + dir*tab_gap;             // face closest to the wall
    
    // Continuously tapered arm (trapezoidal profile in XZ plane) with chamfer at the base
    translate([arm_near_x, y_center + tab_width/2, lid_h])
        rotate([90, 0, 0])
            linear_extrude(height = tab_width)
                polygon([
                    [0, 0],
                    [dir * (tab_thickness + tab_chamfer_w), 0],
                    [dir * tab_thickness, tab_chamfer_h],
                    [dir * tab_tip_thickness, tab_length],
                    [0, tab_length]
                ]);

    hook_tip_x = wall_x + dir*(tab_gap - hook_d);  // protrudes toward/past the wall
    translate([min(arm_near_x, hook_tip_x), y_center - tab_width/2, lid_h + tab_length - hook_h])
        cube([abs(arm_near_x - hook_tip_x), tab_width, hook_h]);
}

// ============================================================================
// Render
// ============================================================================
if (part == "box") {
    box_with_antenna_holes();
} else if (part == "lid") {
    lid();
} else {
    box_with_antenna_holes();
    translate([outer_w + 20, 0, 0])
        lid();
}
