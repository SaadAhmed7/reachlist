import { telegram, telegramConfig } from "./telegram";
import type { Channel, Driver } from "./types";
import { whatsapp } from "./whatsapp";

const DRIVERS: Record<Channel, Driver> = { whatsapp, telegram };

export function driverFor(channel: Channel): Driver {
  return DRIVERS[channel];
}

export { telegramConfig };
export type { Channel, Driver };
