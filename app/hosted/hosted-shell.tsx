import type { CSSProperties, ReactNode } from "react";
import type { PartnerBrand } from "@/lib/partners/brand";

/**
 * The frame every hosted page shares: the partner's name, logo and colours,
 * and nothing of ours unless the partner asked for a "Powered by" line.
 */
export function HostedShell({
  brand,
  children,
}: {
  brand: PartnerBrand;
  children: ReactNode;
}): ReactNode {
  const style = {
    "--brand": brand.primaryColor,
    "--brand-accent": brand.accentColor,
  } as CSSProperties;

  return (
    <main className="min-h-screen bg-white px-4 py-10 text-zinc-900" style={style}>
      <div className="mx-auto w-full max-w-md">
        <header className="mb-8 flex items-center gap-3">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a partner logo on the partner's own host; next/image would need every partner host configured.
            <img src={brand.logoUrl} alt="" className="h-9 w-9 rounded-md object-contain" />
          ) : null}
          <span className="text-lg font-semibold" style={{ color: brand.primaryColor }}>
            {brand.brandName}
          </span>
        </header>
        {children}
        {brand.showPoweredBy ? (
          <p className="mt-10 text-center text-xs text-zinc-400">Powered by MyReply</p>
        ) : null}
      </div>
    </main>
  );
}

/** Shown for a link that is expired, edited or not for this host. No brand: we do not know whose it was. */
export function HostedExpired(): ReactNode {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 text-zinc-900">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold">This link has expired</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Go back to the app you came from and open it again.
        </p>
      </div>
    </main>
  );
}
