import SignInForm from "@/components/auth/SignInForm";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: `${t("signIn")} | ${t("brand")}` };
}

export default function SignIn() {
  return <SignInForm />;
}
