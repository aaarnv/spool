// agent-loom steps file — the demo script for one loom.
// Contract: see CONTRACTS.md in the agent-loom repo.
// Workflow: edit steps → `loom dry <workdir> --headed` until the driver is clean
//           → `loom build <workdir>` for the finished mp4.

export const config = {
  url: 'http://localhost:3000',
  viewport: { width: 1440, height: 900 },
  title: 'My feature walkthrough',
  // Runs before step 0 — recorded but not narrated. Login, seeding, dismissing banners.
  prep: async (page, h) => {},
};

export const steps = [
  {
    name: 'landing',
    narration: "Here's the app — this is where the new feature lives.",
    zoom: 'none',
    run: async (page, h) => {
      await h.pause(800);
    },
  },
  {
    name: 'open-feature',
    narration: 'Clicking in, you can see it working end to end.',
    zoom: 'auto',
    run: async (page, h) => {
      // await h.click('text=Open');
      // await page.waitForSelector('.result');
      await h.pause(800);
    },
  },
];
