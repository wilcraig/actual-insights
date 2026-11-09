import { spreadLabels, heightForLabels, truncateName } from '../src/widgets/label-layout';

const bounds = { gap: 34, min: 20, max: 300 };

test('labels that already clear each other stay where they wanted to be', () => {
  expect(spreadLabels([60, 140, 250], bounds)).toEqual([60, 140, 250]);
});

test('overlapping labels are pushed down just far enough, keeping order', () => {
  // Three bands whose centres sit within a few pixels of each other.
  expect(spreadLabels([200, 204, 208], bounds)).toEqual([200, 234, 268]);
});

test('the result follows the input order even when the input is not sorted', () => {
  expect(spreadLabels([208, 200, 204], bounds)).toEqual([268, 200, 234]);
});

test('a block pushed past the bottom is pulled back up and stays spaced', () => {
  const placed = spreadLabels([290, 292, 295, 298], bounds);
  expect(placed).toEqual([198, 232, 266, 300]);
});

test('a label that wants to sit above the top is moved down to the top', () => {
  expect(spreadLabels([-10, 5], bounds)).toEqual([20, 54]);
});

test('with too little room it stacks from the top at exactly the gap', () => {
  expect(spreadLabels([50, 51, 52, 53], { gap: 34, min: 20, max: 80 })).toEqual([20, 54, 88, 122]);
});

test('handles no labels and one label', () => {
  expect(spreadLabels([], bounds)).toEqual([]);
  expect(spreadLabels([500], bounds)).toEqual([300]);
});

test('heightForLabels never goes below the minimum and grows with the label count', () => {
  const args = { gap: 34, top: 16, bottom: 28, minHeight: 320 };
  expect(heightForLabels(3, args)).toBe(320);
  expect(heightForLabels(12, args)).toBe(452);
});

test('truncateName shortens long names with an ellipsis and leaves short ones alone', () => {
  expect(truncateName('Checking', 22)).toBe('Checking');
  expect(truncateName('Stayntouch 401k Roth Contributions', 22)).toBe('Stayntouch 401k Roth…');
  expect(truncateName(undefined, 5)).toBe('');
});
