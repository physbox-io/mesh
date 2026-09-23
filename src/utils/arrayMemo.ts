// Results remembered against the identity of the arrays they were computed
// from.
//
// A mesh's vertex and face arrays are never edited in place. Every change to a
// shape (a sculpt stroke, a boolean, a nudge that bakes into the vertices)
// hands the scene graph new arrays, and the clones the store and the compiler
// make share the arrays rather than copying them. So "the same arrays as last
// time" means "the same mesh as last time", and anything derived from a mesh
// alone can be kept for as long as its arrays are alive. WeakMaps let go of it
// when they are not.

type Arr = readonly unknown[];

/** A cache keyed on a pair of arrays, usually a mesh's vertices and faces. */
export class PairMemo<V> {
  private readonly byFirst = new WeakMap<Arr, WeakMap<Arr, V>>();

  get(a: Arr, b: Arr, compute: () => V): V {
    let inner = this.byFirst.get(a);
    if (!inner) {
      inner = new WeakMap();
      this.byFirst.set(a, inner);
    }
    if (inner.has(b)) return inner.get(b)!;
    const value = compute();
    inner.set(b, value);
    return value;
  }
}
