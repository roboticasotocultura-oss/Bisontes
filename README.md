# Control de bisontes: servidor

## Requisitos
- Node.js 22.5 o superior (comprueba con `node -v`). No hay que instalar nada más.

## Arrancar
```
node server.js --sim
```
Abre http://localhost:3000 en el navegador. Con `--sim` se generan lecturas de 5 bisontes cada 5 segundos. Sin `--sim` el servidor solo guarda lo que le envíe el collar.

Los datos se guardan en `bisontes.db` (SQLite). Si borras ese archivo, empiezas de cero.

## Enviar una lectura (para el collar real)
```
curl -X POST http://localhost:3000/api/lecturas \
  -H "Content-Type: application/json" \
  -d '{"animal":1,"lat":40.7528,"lng":-3.8113,"bateria":82.5,"temperatura":38.6,"actividad":"Pastando"}'
```
Campos: `animal` (número), `lat`, `lng` (obligatorios); `bateria`, `temperatura`, `actividad`, y `ts` (milisegundos, opcional, por defecto la hora actual).

## Endpoints
- `GET /api/estado`: última lectura de cada animal y la zona.
- `GET /api/historial?animal=1&horas=24`: lecturas del periodo.
- `GET /api/estadisticas?animal=1&horas=24`: distancia, tiempo dentro y fuera, batería, temperatura, actividad.
- `GET/POST/DELETE /api/zona`: leer, guardar o borrar la zona.
- `POST /api/simular-salida/1`: solo para los bisontes del simulador.

## Notas
- La distancia se calcula sumando los tramos entre lecturas. Con GPS real, el ruido de la señal suma distancia falsa cuando el animal está quieto; conviene filtrar lecturas casi iguales antes de dar el dato final.
- La vista previa de Claude no puede conectarse a este servidor. Para verla con datos, ábrela desde `http://localhost:3000`.
