import type { PrismaClient } from "@/../generated/prisma/client";
import { ProEditionError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import type {
  AssetKind,
  AssetVariant,
  ColorUpdate,
  GlobalBrandingDto,
} from "./branding.service";

// Branding mutation stub: color/asset writes require the Pro edition and refuse with a 403 that the
// client turns into an upgrade prompt. Reads (getGlobalBranding/readBrandingAsset) stay public and
// live in branding.service, so the default fazer.ai identity still renders in the Free edition.

export async function updateBrandingColors(
  _ctx: TenantContext,
  _input: ColorUpdate,
  _base?: PrismaClient,
): Promise<GlobalBrandingDto> {
  throw new ProEditionError();
}

export async function setBrandingAsset(
  _ctx: TenantContext,
  _kind: AssetKind,
  _variant: AssetVariant,
  _file: {
    type: string;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  },
  _base?: PrismaClient,
): Promise<GlobalBrandingDto> {
  throw new ProEditionError();
}

export async function clearBrandingAsset(
  _ctx: TenantContext,
  _kind: AssetKind,
  _variant: AssetVariant,
  _base?: PrismaClient,
): Promise<GlobalBrandingDto> {
  throw new ProEditionError();
}
