/**
 * Operator tool for partner apps. Run it yourself against the database; there
 * is deliberately no web endpoint that creates partners or partner keys.
 *
 *   npx tsx --env-file=.env scripts/partner.ts list
 *   npx tsx --env-file=.env scripts/partner.ts create --name "Lash Tech" --brand "Lash Tech" \
 *       --return-origin https://lashtech.app --frame-origin https://lashtech.app --plan PRO
 *   npx tsx --env-file=.env scripts/partner.ts update --partner <id> --domain connect.lashtech.app
 *   npx tsx --env-file=.env scripts/partner.ts key --partner <id> --name "Lash Tech production"
 *   npx tsx --env-file=.env scripts/partner.ts revoke --key <keyId>
 *
 * A key is printed once and never stored in the clear. Lose it and mint another.
 */

import { parseArgs } from "node:util";
import { z } from "zod";
import { PARTNER_SCOPES, normalizeScopes } from "@/lib/api/scopes";
import { prisma } from "@/lib/db/client";
import { normalizeOrigin } from "@/lib/partners/links";
import { generatePartnerKey } from "@/lib/partners/keys";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colours are #RRGGBB");
const domain = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "A bare hostname, such as connect.lashtech.app");

const brandFields = z.object({
  brand: z.string().trim().min(1).max(80).optional(),
  logo: z.string().url().startsWith("https://").optional(),
  primary: hex.optional(),
  accent: hex.optional(),
  domain: domain.optional(),
  "powered-by": z.enum(["on", "off"]).optional(),
  "email-name": z.string().trim().min(1).max(80).optional(),
  "email-address": z.string().email().optional(),
  plan: z.enum(["FREE", "PRO"]).optional(),
});

function origins(list: string[] | undefined, flag: string): string[] | undefined {
  if (!list) return undefined;
  return list.map((raw) => {
    const origin = normalizeOrigin(raw);
    if (!origin) throw new Error(`${flag} ${raw} is not an https origin such as https://lashtech.app`);
    return origin;
  });
}

function brandData(values: Record<string, unknown>): Record<string, unknown> {
  const parsed = brandFields.parse(values);
  return {
    ...(parsed.brand ? { brandName: parsed.brand } : {}),
    ...(parsed.logo ? { logoUrl: parsed.logo } : {}),
    ...(parsed.primary ? { primaryColor: parsed.primary } : {}),
    ...(parsed.accent ? { accentColor: parsed.accent } : {}),
    ...(parsed.domain ? { customDomain: parsed.domain } : {}),
    ...(parsed["powered-by"] ? { showPoweredBy: parsed["powered-by"] === "on" } : {}),
    ...(parsed["email-name"] ? { emailFromName: parsed["email-name"] } : {}),
    ...(parsed["email-address"] ? { emailFromAddress: parsed["email-address"] } : {}),
    ...(parsed.plan ? { workspacePlan: parsed.plan } : {}),
  };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      brand: { type: "string" },
      logo: { type: "string" },
      primary: { type: "string" },
      accent: { type: "string" },
      domain: { type: "string" },
      "powered-by": { type: "string" },
      "email-name": { type: "string" },
      "email-address": { type: "string" },
      plan: { type: "string" },
      "return-origin": { type: "string", multiple: true },
      "frame-origin": { type: "string", multiple: true },
      partner: { type: "string" },
      key: { type: "string" },
      scopes: { type: "string" },
      "expires-days": { type: "string" },
      disable: { type: "boolean" },
      enable: { type: "boolean" },
    },
  });
  const command = positionals[0];

  switch (command) {
    case "list": {
      const partners = await prisma.partner.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          brandName: true,
          customDomain: true,
          returnOrigins: true,
          frameOrigins: true,
          workspacePlan: true,
          disabledAt: true,
          _count: { select: { workspaces: true } },
          keys: {
            select: { id: true, name: true, prefix: true, revokedAt: true, lastUsedAt: true },
          },
        },
      });
      console.log(JSON.stringify(partners, null, 2));
      return;
    }

    case "create": {
      const name = z.string().trim().min(1).max(80).parse(values.name);
      const data = brandData(values);
      const partner = await prisma.partner.create({
        data: {
          name,
          brandName: (data.brandName as string | undefined) ?? name,
          ...data,
          returnOrigins: origins(values["return-origin"], "--return-origin") ?? [],
          frameOrigins: origins(values["frame-origin"], "--frame-origin") ?? [],
        },
        select: { id: true, name: true },
      });
      console.log(`Created partner ${partner.name}: ${partner.id}`);
      return;
    }

    case "update": {
      const id = z.string().min(1).parse(values.partner);
      const returnOrigins = origins(values["return-origin"], "--return-origin");
      const frameOrigins = origins(values["frame-origin"], "--frame-origin");
      await prisma.partner.update({
        where: { id },
        data: {
          ...brandData(values),
          ...(returnOrigins ? { returnOrigins } : {}),
          ...(frameOrigins ? { frameOrigins } : {}),
          ...(values.disable ? { disabledAt: new Date() } : {}),
          ...(values.enable ? { disabledAt: null } : {}),
        },
      });
      console.log(`Updated partner ${id}`);
      return;
    }

    case "key": {
      const partnerId = z.string().min(1).parse(values.partner);
      const label = z.string().trim().min(1).max(80).parse(values.name);
      const scopes = values.scopes ? normalizeScopes(values.scopes.split(",")) : [];
      if (values.scopes && scopes.length === 0) {
        throw new Error(`No known scopes in --scopes. Known: ${PARTNER_SCOPES.join(", ")}`);
      }
      const days = values["expires-days"]
        ? z.coerce.number().int().min(1).max(3650).parse(values["expires-days"])
        : null;
      const { plaintext, prefix, hashedKey } = generatePartnerKey();
      const key = await prisma.partnerApiKey.create({
        data: {
          partnerId,
          name: label,
          prefix,
          hashedKey,
          scopes,
          expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
        },
        select: { id: true },
      });
      console.log(`Key ${key.id} (${prefix}...). Shown once, store it now:\n\n${plaintext}\n`);
      return;
    }

    case "revoke": {
      const keyId = z.string().min(1).parse(values.key);
      const result = await prisma.partnerApiKey.updateMany({
        where: { id: keyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.log(result.count ? `Revoked ${keyId}` : `No live key ${keyId}`);
      return;
    }

    default:
      console.log("Commands: list, create, update, key, revoke. See the top of scripts/partner.ts.");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
