"use client";

import Input from "@/components/form/input/InputField";
import Label from "@/components/form/Label";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { EyeCloseIcon, EyeIcon } from "@/icons";
import { ApiError } from "@/lib/api";
import { useTranslations } from "next-intl";
import { reqEmail } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const schema = z.object({ email: reqEmail, password: z.string().min(1, "Obligatorio") });

export default function SignInForm() {
  const t = useTranslations("auth");
  const { status, login } = useAuth();
  const router = useRouter();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, formState } = form;

  useEffect(() => {
    if (status === "ready") router.replace("/");
    if (status === "needs-company") router.replace("/select-company");
  }, [status, router]);

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await login(v.email.trim(), v.password);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(
        code === "INVALID_CREDENTIALS" ? t("errors.invalidCredentials")
        : code === "ACCOUNT_LOCKED" ? t("errors.accountLocked")
        : err instanceof ApiError && err.status === 429 ? t("errors.tooManyRequests")
        : t("errors.generic"),
      );
    }
  });

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
              <Input id="email" type="email" autoComplete="username" placeholder="usuario@empresa.com" error={!!formState.errors.email} hint={formState.errors.email?.message} {...register("email")} />
            </div>
            <div>
              <Label htmlFor="password">
                {t("password")} <span className="text-error-500">*</span>
              </Label>
              <div className="relative">
                <Input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder={t("passwordPlaceholder")} error={!!formState.errors.password} hint={formState.errors.password?.message} {...register("password")} />
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
            <Button type="submit" className="w-full" size="sm" disabled={formState.isSubmitting}>
              {formState.isSubmitting ? t("signingIn") : t("signIn")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
