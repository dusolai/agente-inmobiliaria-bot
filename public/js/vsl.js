document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const leadId = urlParams.get('lead');
  
  // 1. Ocultar todos los botones de agenda usando CSS dinámico para evitar flickers de HTML
  const style = document.createElement('style');
  style.innerHTML = `
    .calendly {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  let config = {
    delayedButtonSeconds: 300 // Por defecto 5 minutos
  };

  // 2. Traer configuración (retraso)
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      config = await res.json();
    }
  } catch (err) {
    console.error('Error cargando config VSL:', err);
  }

  // 3. Temporizador para mostrar botones
  const delayMs = config.delayedButtonSeconds * 1000;
  console.log(`⏱ Temporizador VSL: botones ocultos. Aparecerán en ${config.delayedButtonSeconds}s`);
  
  setTimeout(() => {
    // Al pasar el tiempo, eliminamos el estilo oculto
    if (document.head.contains(style)) {
      document.head.removeChild(style);
      console.log('✅ Temporizador completado. Botones mostrados.');
    }
  }, delayMs);

  // 4. Tracking automático al hacer click
  // Como los botones ya usan onclick="abrirCalendly()", interceptamos en esa función global
  // Pero para asegurar, le añadimos un listener pasivo a todos
  const botonesCalendly = document.querySelectorAll('.calendly');
  botonesCalendly.forEach(btn => {
    btn.addEventListener('click', () => {
      if (leadId) {
        try {
          // Enviar evento de tracking al servidor (Video Visto / Reunión de Calendly clicada)
          fetch('/tracking/video-click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leadId }),
            keepalive: true
          });
        } catch (err) {
          console.error('Error de tracking:', err);
        }
      }
    });
  });

  if (!leadId) {
    console.warn('⚠️ No se detectó parámetro ?lead= en la URL. El tracking de video no se registrará.');
  }
});
