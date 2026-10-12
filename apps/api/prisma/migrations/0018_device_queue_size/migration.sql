-- 0018: tamaño de la cola de salida que reporta cada dispositivo móvil (monitoreo de colas largas).
ALTER TABLE devices ADD COLUMN queue_size integer;
