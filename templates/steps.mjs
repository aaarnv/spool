// spool steps file — the demo script for one spool.
// Contract: see CONTRACTS.md in the spool repo.
// Workflow: edit steps → `spool dry <workdir> --headed` until the driver is clean
//           → `spool build <workdir>` for the finished mp4.

export const config = {
  url: 'http://localhost:3000',
  viewport: { width: 1600, height: 900 },
  title: 'My feature walkthrough',
  // Runs before step 0 — recorded but not narrated. Login, seeding, dismissing banners.
  prep: async (page, h) => {},
};

// Narration voice: the engineer who built this, updating a client — assume
// familiarity ("the dashboard now does X"), never first-time discovery ("this is X").
export const steps = [
  {
    name: 'landing',
    narration: "Quick update on the build — the new flow is live on the dashboard.",
    zoom: 'none',
    run: async (page, h) => {
      await h.pause(800);
    },
  },
  {
    name: 'open-feature',
    narration: "It's wired end to end now: validation, save, and the result lands here.",
    zoom: 'auto',
    run: async (page, h) => {
      // await h.click('text=Open');
      // await page.waitForSelector('.result');
      await h.pause(800);
    },
  },
];
