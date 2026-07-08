import { SignUp } from "@clerk/nextjs";
import AuthShell from "../../AuthShell";
import { authAppearance } from "../../authAppearance";

export default function Page() {
  return (
    <AuthShell>
      <SignUp appearance={authAppearance} />
    </AuthShell>
  );
}
