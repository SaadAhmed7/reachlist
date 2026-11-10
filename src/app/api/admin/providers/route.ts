import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fail, json, safeProviderError } from "@/lib/api";
import { linkProvider, providerStatus } from "@/lib/presence/pool";
import QRCode from "qrcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Create = z.object({
  channel: z.enum(["WHATSAPP", "TELEGRAM"]),
  /** Optional: a non-technical operator should not have to invent one. */
  label: z.string().max(80).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const rows = await prisma.providerAccount.findMany({ orderBy: { createdAt: "asc" }, select: { id: true } });
    const providers = await Promise.all(
      rows.map(async (r) => {
        const s = await providerStatus(r.id);
        if (!s) return null;
        return {
          ...s,
          // The QR is rendered here so the raw login token never reaches the client.
          qr: s.qrRaw ? await QRCode.toDataURL(s.qrRaw, { margin: 1, width: 240 }) : null,
          qrRaw: undefined,
          // Puppeteer and gramjs errors carry absolute paths and the proxy host.
          lastError: safeProviderError(s.lastError),
          liveError: safeProviderError(s.liveError),
        };
      }),
    );
    return json({ providers: providers.filter(Boolean) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const parsed = Create.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

    // Auto-name it so "Add account" is one click: WhatsApp 1, WhatsApp 2, ...
    const nth = await prisma.providerAccount.count({ where: { channel: parsed.data.channel } });
    const nice = parsed.data.channel === "WHATSAPP" ? "WhatsApp" : "Telegram";
    const label = parsed.data.label?.trim() || `${nice} ${nth + 1}`;

    const provider = await prisma.providerAccount.create({
      data: { channel: parsed.data.channel, label },
      select: { id: true, label: true, channel: true },
    });

    // Start linking immediately: the operator wants a QR, not a form.
    await linkProvider(provider.id).catch(() => {});

    return json({ provider });
  } catch (err) {
    return fail(err);
  }
}
