import { describe, expect, it } from "vitest";

import TemplateDetailPage, {
  generateMetadata,
  generateStaticParams,
} from "../app/templates/[slug]/page";
import {
  CAMPAIGN_TEMPLATES,
  getCampaignTemplateSlugs,
} from "../lib/templates/campaign-templates";

/**
 * The public template pages are the SEO surface, so the thing worth proving is
 * that each one still builds and still ends inside the product. Rendering here
 * is React element construction rather than a DOM: it exercises every lookup
 * the page performs, which is where a missing catalogue entry would surface.
 */
describe("public template pages", () => {
  it("still generates a page for every marketing slug", () => {
    expect(generateStaticParams()).toEqual(
      getCampaignTemplateSlugs().map((slug) => ({ slug }))
    );
  });

  it("renders every template page without throwing", async () => {
    for (const template of CAMPAIGN_TEMPLATES) {
      const element = await TemplateDetailPage({
        params: Promise.resolve({ slug: template.slug }),
      });

      expect(element).toBeTruthy();
    }
  });

  it("keeps a title and a description on every page", async () => {
    for (const template of CAMPAIGN_TEMPLATES) {
      const metadata = await generateMetadata({
        params: Promise.resolve({ slug: template.slug }),
      });

      expect(metadata.title).toContain(template.title);
      expect(metadata.description).toBe(template.summary);
    }
  });

  it("says so when the slug is not a template", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "not-a-template" }),
    });

    expect(metadata.title).toBe("Template Not Found - MyReply");
    await expect(
      TemplateDetailPage({ params: Promise.resolve({ slug: "not-a-template" }) })
    ).rejects.toThrow();
  });
});
