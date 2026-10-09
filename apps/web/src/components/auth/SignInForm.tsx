"use client";

import Input from "@/components/form/input/InputField";
import Label from "@/components/form/Label";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { EyeCloseIcon, EyeIcon } from "@/icons";
import { ApiError } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export default function SignInForm() {
  const t = useTranslations("auth");
  const { status, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "ready") router.replace("/");
    if (status === "needs-company") router.replace("/select-company");
  }, [status, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "INVALID_CREDENTIALS" ? t("errors.invalidCredentials")
        : code === "ACCOUNT_LOCKED" ? t("errors.accountLocked")
        : err instanceof ApiError && err.status === 429 ? t("errors.tooManyRequests")
        : t("errors.generic"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-1 flex-col lg:w-1/2">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5 sm:mb-8">
          <h1 className="mb-2 text-title-sm font-semibold text-gray-800 sm:text-title-md dark:text-white/90">{t("signIn")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("signInHint")}</p>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="space-y-6">
            {error && (
              <div role="alert" className="rounded-lg border border-error-500 bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">
                {error}
              </div>
            )}
            <div>
              <Label htmlFor="email">
                {t("email")} <span className="text-error-500">*</span>
              </Label>
              <Input id="email" type="email" autoComplete="username" placeholder="usuario@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">
                {t("password")} <span className="text-error-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                  onClick={() => setShowPassword(!showPassword)}
                  className="inset-e-4 absolute top-1/2 z-30 -translate-y-1/2 cursor-pointer"
                >
                  {showPassword ? <EyeIcon className="fill-gray-500 dark:fill-gray-400" /> : <EyeCloseIcon className="fill-gray-500 dark:fill-gray-400" />}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" size="sm" disabled={busy || !email || !password}>
              {busy ? t("signingIn") : t("signIn")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
