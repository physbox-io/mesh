import { describe, it, expect } from 'vitest';
import { StockModel, ballProfile } from '../src/utils/stockModel';

describe('StockModel.highestUnder', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  // A 4 mm pass down x = 2 lowers the cells from x = 0 to 4 and no further.
  const slot = () => {
    const stock = new StockModel(bounds, 1);
    stock.cut(2, 0, -3, 2, 10, -3, 2);
    return stock;
  };

  // It used to take every cell whose centre lay within the radius plus half a
  // diagonal: the cell from x = 4 to 5, whose centre is 2.1 mm from the axis
  // and nearest edge 1.6 mm, read as standing under a 1.5 mm cutter.
  it('counts only the cells the footprint reaches', () => {
    const stock = slot();
    expect(stock.highestUnder(2.4, 5, 1.5)).toBeCloseTo(-3, 6);
    expect(stock.highestUnder(2.6, 5, 1.5)).toBe(0);
  });

  it('lowers what a ball sees at its rim by how far its edge rises there', () => {
    const stock = slot();
    // The uncut cell's nearest edge is 1.5 mm out, where a 2 mm ball's edge
    // stands 2 - sqrt(4 - 2.25) = 0.677 mm above its tip.
    expect(stock.highestUnder(2.5, 5, 2, ballProfile(2))).toBeCloseTo(-(2 - Math.sqrt(4 - 2.25)), 3);
    expect(stock.highestUnder(2.5, 5, 2)).toBe(0);
  });

  it('reads the cell under a point for a zero radius', () => {
    const stock = slot();
    expect(stock.highestUnder(3.9, 5, 0)).toBeCloseTo(-3, 6);
    expect(stock.highestUnder(4.1, 5, 0)).toBe(0);
  });
});
