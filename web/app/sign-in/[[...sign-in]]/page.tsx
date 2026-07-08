import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh", padding: "40px 20px" }}>
      <SignIn />
    </main>
  );
}
