/**
 * Create (or reset) the first admin.
 *
 *   npm run admin:create -- admin@example.com 'a good password'
 *
 * Re-running with an existing email resets that account's password and makes
 * it an admin again, which is the lockout escape hatch.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth";

const prisma = new PrismaClient({ log: ["error"] });

async function main() {
  const [emailArg, password] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();

  if (!email || !password) {
    console.error("usage: npm run admin:create -- <email> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "ADMIN", active: true },
    create: { email, passwordHash, role: "ADMIN", name: "Administrator" },
    select: { id: true, email: true, credits: true },
  });

  console.log(`admin ready: ${user.email} (${user.credits} credits)`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
