// ============================================================================
// Enclosure for Hosyond ESP32-S3 CYD (Cheap Yellow Display)
// Portrait orientation, screw-together lid + box.
//
// ASSUMPTIONS (board hole pattern is not published by Hosyond - verify against
// your physical board before printing, adjust board_hole_inset/board_hole_d
// if needed):
//   - 4 mounting holes, inset `board_hole_inset` from each board edge, M3 clearance
//   - Screen (69x49) is flush with the board's top 69mm and full 49mm width,
//     leaving the remaining 15mm at the bottom edge for USB-C + GPIO header
//
// Render one part at a time: set `part` below to "box", "lid", or "both"
// (both = side-by-side preview, not print-safe as one plate)
// ============================================================================

part = "both"; // "box" | "lid" | "both"

// ---- Board & display -------------------------------------------------------
board_l = 84;           // board length (portrait long axis)
board_w = 49;           // board width
screen_l = 69;          // screen length
screen_w = 49;          // screen width
comfort = 15;           // extra room added to interior length & width

board_hole_inset = 4;   // board corner mounting holes, inset from board edge
board_hole_d = 3.2;     // M3 clearance

// ---- Enclosure shell --------------------------------------------------------
wall = 2.5;                       // side wall thickness
interior_l = board_l + comfort;   // 99
interior_w = board_w + comfort;   // 64
outer_l = interior_l + 2*wall;    // 104  (portrait long axis)
outer_w = interior_w + 2*wall;    // 69   (portrait short axis)

total_depth = 45;   // overall assembled depth (box_h + lid_h)
lid_h = 8;           // lid = thin front bezel with screen window + pillars
box_h = total_depth - lid_h; // 37, deep back cover

// ---- Corner screw posts (M6, lid <-> box) -----------------------------------
// Box-side hole is a snug M6 slip-fit, not a self-tap pilot: the screw is glued
// in (superglue) rather than relying on threads cut into the plastic, so it's
// sized to the screw's actual diameter rather than undersized for tapping.
// It's also blind (pilot_depth < box_h) so it doesn't break through the box's
// exterior floor.
corner_post = 14;        // square post cross-section at each corner
post_inset = 9;          // diagonal inset of hole center from the true corner, per spec
post_offset = post_inset / sqrt(2); // ~6.364mm component offset in x and y
m6_clear_d = 6.5;        // clearance hole (lid side, screw head/shaft passes through)
m6_pilot_d = 6.0;        // box side, snug M6 slip-fit for a glued (not threaded) joint
pilot_depth = 20;        // box-side hole depth from the top - blind, leaves box_h-pilot_depth solid below
                         // (~25mm M6 screw: (lid_h - m6_head_h) engaging the lid + pilot_depth into the box)
m6_head_d = 11;          // countersink diameter for screw head, lid side
m6_head_h = 3;           // countersink depth

// ---- Board standoff pillars (in lid) ----------------------------------------
pillar_od = 8;
pillar_pilot_d = 2.5;    // self-tap pilot for M3 into pillar
pillar_h = 5;            // stands board off the inner lid face

// ---- Screen window (lid) -----------------------------------------------------
window_margin = 2;       // bezel overlap over screen edge, per side

// ---- Antenna holes (box, top wall = far end from USB/GPIO) ------------------
whip_hole_d = 7;         // small whip antenna (SMA-style) hole
phone_hole_d = 13;       // solid plastic cellphone-style antenna base
antenna_hole_margin = 9; // clearance from corner post edge

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
// BOX (deep back cover: walls + floor + antenna holes + USB/GPIO slot + posts)
// ============================================================================
module box_with_antenna_holes() {
    antenna_x1 = corner_post + antenna_hole_margin;               // whip, near left post
    antenna_x2 = outer_w - corner_post - antenna_hole_margin;     // phone-style, near right post

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
    }

    // re-add corner posts as solid reinforcement blocks (so the screw boss has
    // enough surrounding material even though the hollow above ate into the corner),
    // with a blind M6 hole cut from the top only (see corner_post_solid)
    corner_post_solid(box_h, m6_pilot_d, pilot_depth);
}

// hole_depth < height cuts a BLIND hole from the top face only, leaving
// (height - hole_depth) of solid material below - use height itself for a
// full through-hole (e.g. the thin lid, which needs clearance all the way through)
module corner_post_solid(height, hole_d, hole_depth) {
    for (cx = [0, 1]) for (cy = [0, 1]) {
        ox = cx==0 ? 0 : outer_w - corner_post;
        oy = cy==0 ? 0 : outer_l - corner_post;
        hx = cx==0 ? post_offset : outer_w - post_offset;
        hy = cy==0 ? post_offset : outer_l - post_offset;
        difference() {
            translate([ox, oy, 0])
                cube([corner_post, corner_post, height]);
            translate([hx, hy, height - hole_depth])
                cylinder(h=hole_depth+1, d=hole_d, $fn=32);
        }
    }
}

// ============================================================================
// LID (thin front bezel: screen window + M6 clearance holes + board pillars)
// ============================================================================
module lid() {
    screen_y0_local = board_l - screen_l; // screen sits flush with the top edge
    window_w = screen_w - 2*window_margin;
    window_l = screen_l - 2*window_margin;
    window_x0 = board_x0 + (board_w - window_w) / 2;
    window_y0 = board_y0 + screen_y0_local + window_margin;

    difference() {
        cube([outer_w, outer_l, lid_h]);

        // screen window, full through-cut
        translate([window_x0, window_y0, -1])
            cube([window_w, window_l, lid_h + 2]);

        // M6 clearance + countersink at all 4 corners
        for (cx = [0, 1]) for (cy = [0, 1]) {
            hx = cx==0 ? post_offset : outer_w - post_offset;
            hy = cy==0 ? post_offset : outer_l - post_offset;
            translate([hx, hy, -1])
                cylinder(h=lid_h+2, d=m6_clear_d, $fn=32);
            translate([hx, hy, lid_h - m6_head_h])
                cylinder(h=m6_head_h+1, d=m6_head_d, $fn=32);
        }
    }

    // corner reinforcement (lid is thin, keep posts solid around the M6 holes) -
    // full through-hole (hole_depth = lid_h) since the lid needs clearance all the way
    corner_post_solid(lid_h, m6_clear_d, lid_h);

    // board standoff pillars at the 4 board mounting holes
    for (px = [board_hole_inset, board_w - board_hole_inset])
        for (py = [board_hole_inset, board_l - board_hole_inset]) {
            translate([board_x0 + px, board_y0 + py, lid_h])
                difference() {
                    cylinder(h=pillar_h, d=pillar_od, $fn=32);
                    translate([0,0,-1])
                        cylinder(h=pillar_h+2, d=pillar_pilot_d, $fn=32);
                }
        }
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
