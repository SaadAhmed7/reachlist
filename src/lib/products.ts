/**
 * The catalogue.
 *
 * One entry per thing this service can actually do, which is the point: a
 * product listed here must be deliverable today. Every card the client can
 * click leads to a working check, not a "coming soon".
 *
 * Shared by the sidebar, the catalogue grid and the product pages, so a new
 * capability is added once, here, and appears everywhere.
 */
import type { $Enums } from "@prisma/client";

export type Channel = Extract<$Enums.Channel, "WHATSAPP" | "TELEGRAM">;

/** Sidebar grouping, and the filter chips above the grid — same vocabulary. */
export type Category = "Phone status" | "Social platforms" | "Time-based check";

export type Product = {
  slug: string;
  name: string;
  /** One line on the card. Says what the client gets, not how it works. */
  blurb: string;
  category: Category;
  /** Shown as a tag on the card. "Popular" is the only promotional one. */
  tags: string[];
  /**
   * Channels this product looks up. Empty means it answers offline, which is
   * why it is free — nothing is asked of WhatsApp or Telegram.
   */
  channels: Channel[];
  /** Which logo to draw. */
  icon: "whatsapp" | "telegram" | "both" | "phone";
  /** Put the Telegram last-seen day filter front and centre. */
  lastSeen?: boolean;
  /** Longer copy for the product page itself. */
  about: string;
  /** What the client should expect, stated plainly. Rendered as a list. */
  notes: string[];
};

export const PRODUCTS: Product[] = [
  {
    slug: "number-validation",
    name: "Number validation",
    blurb:
      "Clean a list before you spend anything: drop blanks, duplicates and " +
      "landlines, and see which country each number belongs to.",
    category: "Phone status",
    tags: ["Free", "Popular"],
    channels: [],
    icon: "phone",
    about:
      "Checks each number against its country's numbering plan and tells you " +
      "whether it could be a mobile at all. Nothing is sent to WhatsApp or " +
      "Telegram, so it costs no credits and carries no risk to the linked " +
      "accounts. Run this first — paying to look up a landline is wasted money.",
    notes: [
      "Runs in your browser. The numbers never leave this page.",
      "Tells you valid or invalid, the country, and mobile vs landline.",
      "Cannot tell you whether someone uses WhatsApp or Telegram — use the other products for that.",
    ],
  },
  {
    slug: "whatsapp-status",
    name: "WhatsApp status",
    blurb: "Check which numbers in a list are registered on WhatsApp.",
    category: "Social platforms",
    tags: ["Popular"],
    channels: ["WHATSAPP"],
    icon: "whatsapp",
    about:
      "Asks WhatsApp directly, through a linked account, whether each number " +
      "has an account. You get back only the numbers that do.",
    notes: [
      "1 credit per number.",
      "Only registered numbers are kept. The rest are deleted when the run finishes.",
      "Speed depends on how many WhatsApp accounts are linked — the work is shared between them.",
    ],
  },
  {
    slug: "telegram-status",
    name: "Telegram status",
    blurb: "Check which numbers in a list are registered on Telegram.",
    category: "Social platforms",
    tags: ["Popular"],
    channels: ["TELEGRAM"],
    icon: "telegram",
    about:
      "Asks Telegram, through a linked account, whether each number resolves " +
      "to a real user. You get back only the numbers that do.",
    notes: [
      "1 credit per number.",
      "Only registered numbers are kept. The rest are deleted when the run finishes.",
      "Some people hide themselves from lookup by number; those read as not found.",
    ],
  },
  {
    slug: "telegram-last-seen",
    name: "Telegram last seen",
    blurb:
      "Find the Telegram users who have actually been active recently — " +
      "filter a list down to the last 1 to 7 days, or any window you choose.",
    category: "Time-based check",
    tags: ["Popular"],
    channels: ["TELEGRAM"],
    icon: "telegram",
    lastSeen: true,
    about:
      "The same Telegram lookup, with the activity filter in front. Useful " +
      "when a live audience matters more than a large one.",
    notes: [
      "1 credit per number — the activity comes with the registration lookup, so it is not charged twice.",
      "Telegram reports activity as a range, not an exact time, so the filter only includes numbers it can prove fall inside your window.",
      "People who hide their last-seen are left out and counted separately.",
    ],
  },
  {
    slug: "whatsapp-telegram",
    name: "WhatsApp + Telegram",
    blurb:
      "Check both platforms in one run and keep every number reachable on " +
      "either of them.",
    category: "Social platforms",
    tags: [],
    channels: ["WHATSAPP", "TELEGRAM"],
    icon: "both",
    about:
      "Runs both checks over the same list at the same time. A number is kept " +
      "if it is on WhatsApp, on Telegram, or on both.",
    notes: [
      "2 credits per number — one for each platform.",
      "Both run at once, so it takes about as long as the slower of the two.",
      "Numbers found on neither are deleted when the run finishes.",
    ],
  },
];

export const CATEGORIES: Category[] = [
  "Phone status",
  "Social platforms",
  "Time-based check",
];

export function productBySlug(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

/** Credits one number costs on this product. Offline products are free. */
export function productPrice(p: Product): number {
  return p.channels.length;
}

/** Products grouped for the sidebar, in catalogue order, empty groups dropped. */
export function productsByCategory(): { category: Category; items: Product[] }[] {
  return CATEGORIES
    .map((category) => ({ category, items: PRODUCTS.filter((p) => p.category === category) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Free-text match over the fields a person would actually type.
 *
 * Deliberately forgiving: "ws", "wa" and "whatsapp" all find the same card,
 * because the client will type whichever one is in their head.
 */
const ALIASES: Record<string, string[]> = {
  "whatsapp-status": ["ws", "wa", "whats app"],
  "telegram-status": ["tg", "tele"],
  "telegram-last-seen": ["tg", "tele", "days", "active", "activity", "online"],
  "whatsapp-telegram": ["ws", "wa", "tg", "both", "all"],
  "number-validation": ["clean", "valid", "landline", "mobile", "filter"],
};

export function matchesQuery(p: Product, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [
    p.name, p.blurb, p.category, ...p.tags, ...(ALIASES[p.slug] ?? []),
  ].join(" ").toLowerCase();
  // Every word must appear somewhere, so "telegram days" narrows rather than widens.
  return q.split(/\s+/).every((word) => hay.includes(word));
}
