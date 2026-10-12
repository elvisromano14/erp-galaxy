"use client";

import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useNotice } from "@/context/NoticeContext";
import { post } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import QRCode from "qrcode";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Info = { available: boolean; version: string | null; fileName: string | null; sizeBytes: number | null; sha256: string | null; uploadedAt: string | null; notes: string | null; minAppVersion: string };
type Link = Info & { url: string; expiresAt: string };

/** Descarga de la app móvil (APK) desde el ERP: enlace firmado de vida corta y código QR para abrirlo desde el teléfono. */
export default function MobileAppPage() {
  const t = useTranslations();
  const notice = useNotice();
  const info = useFetch<Info>("/mobile/app");
  const [link, setLink] = useState<{ href: string; expiresAt: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const r = await post<Link>("/mobile/app/link", {});
      const href = `${window.location.origin}${r.data.url}`;
      setLink({ href, expiresAt: r.data.expiresAt, qr: await QRCode.toDataURL(href, { margin: 1, width: 260 }) });
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.href); notice.success(t("settings.linkCopied")); } catch { notice.error(t("settings.linkCopyFailed")); }
  }

  const d = info.data;
  const mb = d?.sizeBytes ? `${(d.sizeBytes / 1_048_576).toFixed(1)} MB` : "—";

  return (
    <div>
      <PageHeader title={t("sidebar.items.mobileApp")} subtitle={t("settings.mobileAppSubtitle")} />
      <ErrorBox error={info.error} />
      {info.loading && !d ? <Loading /> : !d?.available ? (
        <Card><p className="text-sm text-gray-500">{t("settings.apkNotAvailable")}</p></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title={t("settings.apkVersionCard")}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-gray-500">{t("settings.apkVersion")}</dt><dd className="font-medium text-gray-800 dark:text-white/90">{d.version}</dd>
              <dt className="text-gray-500">{t("settings.apkSize")}</dt><dd className="text-gray-800 dark:text-white/90">{mb}</dd>
              <dt className="text-gray-500">{t("settings.apkPublished")}</dt><dd className="text-gray-800 dark:text-white/90">{d.uploadedAt ? fmtDateTime(d.uploadedAt) : "—"}</dd>
              <dt className="text-gray-500">{t("settings.apkMinVersion")}</dt><dd className="text-gray-800 dark:text-white/90">{d.minAppVersion}</dd>
              <dt className="text-gray-500">SHA-256</dt><dd className="break-all font-mono text-xs text-gray-800 dark:text-white/90">{d.sha256}</dd>
              {d.notes && (<><dt className="text-gray-500">{t("settings.apkNotes")}</dt><dd className="text-gray-800 dark:text-white/90">{d.notes}</dd></>)}
            </dl>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={busy} onClick={generate}>{busy ? t("common.loading") : link ? t("settings.regenerateLink") : t("settings.generateLink")}</Button>
              {link && <a className="text-sm font-medium text-brand-500 hover:underline" href={link.href} download>{t("settings.downloadApk")}</a>}
              {link && <Button size="sm" variant="outline" onClick={copy}>{t("settings.copyLink")}</Button>}
            </div>
            {link && <p className="mt-2 text-xs text-gray-500">{t("settings.linkValidUntil", { time: new Date(link.expiresAt).toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }) })}</p>}
          </Card>

          <Card title={t("settings.installSteps")}>
            {link ? (
              <div className="mb-4 flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={link.qr} alt={t("settings.qrAlt")} width={220} height={220} className="rounded-lg border border-gray-200 bg-white p-2" />
                <p className="text-center text-xs text-gray-500">{t("settings.qrHint")}</p>
              </div>
            ) : (
              <p className="mb-4 text-sm text-gray-500">{t("settings.generateToSeeQr")}</p>
            )}
            <ol className="list-decimal space-y-2 ps-5 text-sm text-gray-700 dark:text-gray-300">
              <li>{t("settings.step1")}</li>
              <li>{t("settings.step2")}</li>
              <li>{t("settings.step3")}</li>
              <li>{t("settings.step4")}</li>
            </ol>
            <p className="mt-4 text-xs text-gray-500">{t("settings.shaHint")}</p>
          </Card>
        </div>
      )}
    </div>
  );
}
