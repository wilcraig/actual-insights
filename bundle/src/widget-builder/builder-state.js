import { bodyOf, buildPlaceholder } from './placeholder';
import { checkedGroupIds } from './group-order';

// The builder's form logic, with no DOM in it: what a widget's fields start
// as, whether the form is complete enough to build (or preview) the widget,
// and what placeholder / config it produces. BuilderModal.svelte only wires
// these to inputs.

export function isPickerField(field) {
  return field.type === 'category-multiselect'
    || field.type === 'account-multiselect'
    || field.type === 'group-multiselect';
}

// Where each picker field loads its options from. group-multiselect uses the
// dedicated /api/category-groups endpoint rather than deriving groups from
// /api/categories' flattened groupName (that route drops hidden groups and the
// hidden flag itself, so a client-side dedup can't tell a hidden group apart
// from one that doesn't exist).
export const PICKER_SOURCES = {
  'category-multiselect': { path: '/api/categories', responseKey: 'categories' },
  'account-multiselect': { path: '/api/accounts', responseKey: 'accounts' },
  'group-multiselect': { path: '/api/category-groups', responseKey: 'groups' },
};

/** A widget's starting form values, one per field. */
export function defaultValues(widget) {
  const values = {};
  for (const field of widget?.fields ?? []) {
    if (isPickerField(field)) values[field.key] = [];
    else if (field.type === 'checkbox') values[field.key] = field.default === true;
    // A select starts on its first option, so a single-choice field never
    // blocks the form the way an empty multiselect does.
    else if (field.type === 'select') values[field.key] = field.options[0]?.value ?? '';
  }
  return values;
}

/** Pacing bars' "Category Groups" ordering list is showing. */
export function showsGroupList(widget, values) {
  return widget?.id === 'pacing-bars' && values.allGroups === true;
}

/**
 * Whether the form is complete enough to build the widget. A widget with
 * fields can't be built with nothing selected in a required one (that is the
 * empty-placeholder pain this builder exists to prevent); a widget with no
 * fields is always buildable.
 */
export function isComplete(widget, values, groupRows) {
  if (!widget) return false;
  if (widget.fields.length === 0) return true;
  // Category Groups ticked: needs a checked group or a picked category.
  if (showsGroupList(widget, values)) {
    return (groupRows ?? []).some((row) => row.checked) || (values.categoryIds ?? []).length > 0;
  }
  return widget.fields.every(
    (field) => field.optional
      || field.type === 'checkbox'
      || (field.optionalWhen && values[field.optionalWhen] === true)
      || (values[field.key] ?? []).length > 0,
  );
}

function finalValues(widget, values, groupRows) {
  return showsGroupList(widget, values) && groupRows
    ? { ...values, groupIds: checkedGroupIds(groupRows) }
    : values;
}

/** The parsed placeholder body for the current form (null when incomplete). */
export function configFor(widget, values, groupRows) {
  if (!isComplete(widget, values, groupRows)) return null;
  // Wrapped so a legitimately falsy body (an empty array, null) still reads as "built".
  return { body: bodyOf(widget.fields, finalValues(widget, values, groupRows), widget.toBody) };
}

/** The `{{INSIGHTS:...}}` text for the current form ('' when incomplete). */
export function placeholderFor(widget, values, groupRows) {
  if (!isComplete(widget, values, groupRows)) return '';
  return buildPlaceholder(widget.id, widget.fields, finalValues(widget, values, groupRows), widget.toBody);
}
