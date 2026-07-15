"use client";

import { useEffect, useState } from "react";

type Group = { label: string; links: { href: string; text: string }[] };

// Scroll-spy sidebar: highlights the section nearest the top of the viewport.
export default function DocsNav({ nav }: { nav: Group[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const ids = nav.flatMap((g) => g.links.map((l) => l.href.slice(1)));
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    if (!sections.length) return;

    const pick = () => {
      let current = sections[0].id;
      for (const el of sections) {
        if (el.getBoundingClientRect().top <= 140) current = el.id;
      }
      setActive(current);
    };
    pick();
    window.addEventListener("scroll", pick, { passive: true });
    return () => window.removeEventListener("scroll", pick);
  }, [nav]);

  return (
    <nav className="spool-docs__nav" aria-label="Docs sections">
      {nav.map((group) => (
        <div className="spool-docs__nav-group" key={group.label}>
          <div className="spool-docs__nav-lbl">{group.label}</div>
          {group.links.map((l) => (
            <a key={l.href} href={l.href} data-active={active === l.href.slice(1)}>
              {l.text}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}
