import Link from "next/link";
import { sans } from "./components/marketing/fonts";
import styles from "./authShell.module.css";

// Full-page Spool-branded frame for the Clerk auth cards: ambient dark
// background + logo/wordmark linking home, with the card centered beneath.
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className={`${styles.wrap} ${sans.variable}`}>
      <Link href="/" className={styles.brand}>
        <img src="/logo.svg" alt="" aria-hidden="true" />
        <span>Spool</span>
      </Link>
      <div className={styles.card}>{children}</div>
    </main>
  );
}
