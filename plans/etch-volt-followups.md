# Etch and Volt: changes that follow from Mesh's 2026-11-01 work

Written while fixing an agent's mold-making notes in Mesh and adding
physics_export_cut. Each item says what Mesh now does, and what the sibling
app lacks.

## Etch

1. **Deploy `ed0b1a1` (etch_set_svg takes name, thickness_mm, machine,
   true_size).** Done in the repo; until it is live, a `physics_export_cut`
   with `to_etch` into a production Etch tab imports the drawing but ignores
   the name and stock, and places it where its coordinates fall rather than
   at true size on the bed.
2. **Tab identity in the HELLO.** Etch's handshake sends app, port and token
   only, so `list_sessions` shows its tab as "unknown (old client)" and two
   Etch tabs cannot be told apart or pinned. Mesh sends `sessionId`, `label`,
   `href` and `startedAt` (`tabIdentity()` in `src/hooks/useMCPBridge.ts`).
3. **`LIST_COMMANDS` for send_command.** Mesh answers it with every command
   it takes. Etch's bridge is a `switch`, so its commands cannot be listed
   without keeping a list beside it; worth a table of handlers, as Mesh's
   `COMMANDS` map is.
4. **Contour has no "Open in Etch" in Mesh**, while SVG/Laser Cut and Unfold
   do. The Etch button and physics_export_cut cover it, but the Contour
   dialog should have the button too.
5. **Check for stock edited inside export dialogs.** Mesh removed the stock
   fields from Relief Carve and Contour: the stock is set once, in the
   status bar. If Etch has per-dialog stock or thickness fields that write
   the document's stock, the same rule applies.
6. **Export names.** Mesh named every export from a blank scene `empty.stl`
   (the blank preset's id). Check Etch's export naming for the same
   fallback.

## Volt

1. **Tab identity in the HELLO**, as Etch item 2, if Volt's handshake lacks
   it too.
2. **`LIST_COMMANDS` for send_command**, as Etch item 3. Volt's bridge is also
   a `switch`.
3. **Export names**, as Etch item 6.
4. **UI/MCP parity of export subjects.** Mesh's exports now take the
   selection (or the whole scene), and their MCP tools take `master_id`. If
   Volt's exports (Gerbers, the PCB mill job, the enclosure faceplate) act
   on a selection in the UI, their tools should say what they act on in the
   same way.

## physbox-mcp

- `send_command`'s docstring named 5175 "physics" and left out Etch; fixed,
  unreleased (goes with the next release).
- Restart running MCP servers to pick up v0.55-v0.57.
