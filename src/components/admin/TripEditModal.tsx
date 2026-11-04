/**
 * The trip editor used to be a tabbed modal; it is now the full-page workspace in
 * ./tripEditor. These names stay so the admin page and the tests keep importing
 * from here.
 */
export { TripEditor as TripEditModal, type TripEditorProps as TripEditModalProps, type TripDraftState } from "./tripEditor/TripEditor";
export { TripDatePriceEditor, parseAgeRange, formatAgeRange } from "./tripEditor/PricingEditor";
