"use client";

import { Modal } from "@/components/ui/modal";
import Button from "@/components/ui/button/Button";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TextField } from "./FormFields";

/** Confirmación con motivo obligatorio opcional (anulaciones: erp-v3 §14.2). */
export default function ConfirmDialog({ open, title, message, requireReason, confirmLabel, danger, busy, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  message?: string;
  requireReason?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const t = useTranslations("common");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const invalid = requireReason && reason.trim().length < 3;
  return (
    <Modal isOpen={open} onClose={onCancel} className="m-4 max-w-md p-6">
      <div role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="mb-2 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{title}</h3>
        {message && <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{message}</p>}
        {requireReason && <TextField label={t("reason")} required value={reason} onChange={setReason} hint={t("reasonHint")} />}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" disabled={busy || invalid} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel ?? t("confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
