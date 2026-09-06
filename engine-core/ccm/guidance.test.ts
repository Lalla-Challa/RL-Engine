import assert from "node:assert/strict";
import { CCM_SECTION_IDS, getSectionById, searchSections } from "./guidance";

function contentTokens(sections: { content: string }[]): number {
  return Math.ceil(sections.reduce((total, section) => total + section.content.length, 0) / 4);
}

async function main(): Promise<void> {
  for (const id of ["actors", "actor-knowledge", "system-rules", "no-retroactive-motivation"]) {
    const section = getSectionById(id);
    assert(section, `Expected ${id} to be indexed`);
    assert(section.content.length > 0, `Expected ${id} to have content`);
  }
  assert.equal(getSectionById("not-a-real-ccm-section"), null);

  assert(!CCM_SECTION_IDS.includes("purpose"), "Purpose framing should not be indexed");
  assert(!CCM_SECTION_IDS.includes("authorial-control"), "Author-role framing should not be indexed");

  const semantic = await searchSections(
    "Why can't a character act on something they do not learn until later?",
    { topK: 4, tokenBudget: 1200 }
  );
  assert(
    semantic.some((section) => section.title === "NO RETROACTIVE MOTIVATION"),
    "Expected the paraphrased knowledge-time query to surface no-retroactive motivation"
  );

  const constrained = await searchSections(
    "What rules determine whether a character knows enough to act?",
    { topK: 3, tokenBudget: 50 }
  );
  assert(contentTokens(constrained) <= 50, "Semantic guidance must honor the hard token budget");

  console.log("CCM guidance tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
