import type { Channel } from "./products";
import { prisma } from "./db";
import { greenApiEnabled } from "./presence/greenapi";

/**
 * Which channels can actually serve a lookup right now.
 *
 * Shared by every page that offers a paid check, so the catalogue, a product
 * page and the old combined checker can never disagree about whether WhatsApp
 * is up. A channel counts as available through a linked session of ours or
 * through GREEN-API, which has no session to link.
 */
export async function availableChannels(): Promise<Channel[]> {
  const live = await prisma.providerAccount.groupBy({
    by: ["channel"],
    where: { enabled: true, status: { in: ["READY", "DISCONNECTED"] } },
    _count: true,
  });

  return (["WHATSAPP", "TELEGRAM"] as const).filter(
    (c) => greenApiEnabled(c) || live.some((l) => l.channel === c),
  );
}
