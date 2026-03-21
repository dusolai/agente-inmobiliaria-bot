document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const leadId = urlParams.get('lead');
  
  const ctaSection = document.getElementById('cta-section');
  const agendaBtn = document.getElementById('agenda-btn');
  const vslVideo = document.getElementById('vsl-video');
  const empresaNombre = document.getElementById('empresa-nombre');

  let config = {
    delayedButtonSeconds: 300,
    reunionGrupalUrl: '#',
    vslVideoUrl: '',
    empresaNombre: 'Three Inmobiliaria'
  };

  // 1. Fetch public config
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      config = await res.json();
      empresaNombre.textContent = config.empresaNombre;
      document.title = `Presentación Exclusiva - ${config.empresaNombre}`;
      vslVideo.src = config.vslVideoUrl;
      agendaBtn.href = config.reunionGrupalUrl;
    }
  } catch (err) {
    console.error('Error cargando config:', err);
  }

  // 2. Delayed Button Logic
  // Para pruebas, el delay podría estar en ms. En prod, el servidor devuelve segundos.
  const delayMs = config.delayedButtonSeconds * 1000;
  
  console.log(`⏱ Temporizador iniciado: el botón aparecerá en ${config.delayedButtonSeconds}s`);
  
  setTimeout(() => {
    ctaSection.classList.remove('hidden');
  }, delayMs);

  // 3. Click Tracking
  agendaBtn.addEventListener('click', async (e) => {
    // No prevenimos el comportamiento por defecto (queremos que vaya a Calendly/Grupal)
    
    if (leadId) {
      try {
        // Enviar evento de clic al servidor de forma asíncrona
        fetch('/tracking/video-click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId }),
          keepalive: true // Asegura que la petición salga aunque el navegador cambie de página
        });
      } catch (err) {
        console.error('Error enviando evento de tracking:', err);
      }
    }
  });

  // Si no hay leadId, mostramos mensaje en consola para desarrollo
  if (!leadId) {
    console.warn('⚠️ No se detectó parámetro ?lead= en la URL. El tracking no funcionará para este usuario visitante.');
  }
});
