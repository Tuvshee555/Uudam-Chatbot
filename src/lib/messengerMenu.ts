/**
 * The Page's Messenger persistent menu (the ≡ menu beside the composer, visible in every
 * conversation at any moment) carries "Хүнтэй холбогдох": a customer can ask for a person
 * whatever the bot is doing. The menu also holds the owner's own items, set in Meta Business
 * Suite, so the item is ADDED to what is there — never a replacement (scripts/messenger-menu.ts).
 */
import { HUMAN_REQUEST_LABEL, HUMAN_REQUEST_PAYLOAD } from "./contactLabels";

export type MenuAction = { type: string; title?: string; payload?: string; url?: string; [key: string]: unknown };
export type PersistentMenu = { locale: string; composer_input_disabled?: boolean; call_to_actions?: MenuAction[]; [key: string]: unknown };

/** Meta's limit on top-level persistent menu items. */
export const MAX_MENU_ITEMS = 20;

export const HUMAN_REQUEST_ACTION: MenuAction = { type: "postback", title: HUMAN_REQUEST_LABEL, payload: HUMAN_REQUEST_PAYLOAD };

const isHumanRequest = (action: MenuAction) => action.payload === HUMAN_REQUEST_PAYLOAD || action.title === HUMAN_REQUEST_LABEL;

/**
 * Every locale's menu with the hand-off item first (the most visible place), the owner's items
 * kept in their order. A Page with no menu gets a default-locale one. `changed` is false when
 * every locale already has it.
 */
export function withHumanRequestItem(menus: PersistentMenu[] | undefined): { menus: PersistentMenu[]; changed: boolean } {
  const source = menus?.length ? menus : [{ locale: "default", composer_input_disabled: false, call_to_actions: [] }];
  let changed = !menus?.length;
  const next = source.map((menu) => {
    const actions = menu.call_to_actions ?? [];
    if (actions.some(isHumanRequest)) return menu;
    if (actions.length >= MAX_MENU_ITEMS) throw new Error(`persistent menu "${menu.locale}" already has ${MAX_MENU_ITEMS} items`);
    changed = true;
    return { ...menu, call_to_actions: [HUMAN_REQUEST_ACTION, ...actions] };
  });
  return { menus: next, changed };
}
