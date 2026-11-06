# Certificado público de Supabase

Descargado el 6/11/2026 desde el enlace **Download certificate** del panel del proyecto, Database → Settings → SSL configuration:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Este archivo contiene únicamente la CA pública, no una clave privada. Se incluye en API y worker para verificar las conexiones PostgreSQL del Session Pooler. No se desactiva `rejectUnauthorized` ni la comprobación del hostname.

Al rotarlo, verificar el nuevo certificado mediante el panel oficial, actualizarlo y reconstruir ambos servicios. La provisión local también usa este archivo.
