document.addEventListener('DOMContentLoaded', () => {
  fetchStats();
  fetchLeads();
});

const formatFecha = (isoString) => {
  if (!isoString) return '-';
  const d = new Date(isoString);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const getBadgeClass = (estado) => {
  if (estado === 'nuevo' || estado === 'video_enviado') return 'nuevo';
  if (estado === 'video_visto' || estado === 'reunion_registrado') return 'video_visto';
  if (estado === 'agenda_1a1') return 'agenda_1a1';
  if (estado === 'descartado') return 'descartado';
  return '';
};

// Formato amigable de estado
const formatEstado = (estado) => {
  const map = {
    'nuevo': 'Nuevo',
    'video_enviado': 'Video Enviado',
    'video_visto': 'Video Visto',
    'reunion_registrado': 'Registrado a Grupal',
    'reunion_asistio': 'Asistió a Grupal',
    'agenda_1a1': 'Cierre 1a1',
    'descartado': 'Descartado'
  };
  return map[estado] || estado;
};

// Obtener botón de acción según el estado
const getActionButtons = (leadId, estado) => {
  if (estado === 'video_enviado') {
    return `<button class="btn-secondary btn-small" onclick="simulateAction('${leadId}', 'video')">Simular Clic Video</button>`;
  } else if (estado === 'video_visto') {
    return `<button class="btn-secondary btn-small" onclick="simulateAction('${leadId}', 'reunion')">Simular Pre-registro Reunión</button>`;
  } else if (estado === 'reunion_registrado') {
    return `<button class="btn-secondary btn-small" onclick="simulateAction('${leadId}', 'asistencia')">Simular Asistir a Zoom</button>`;
  }
  return '<span style="color:var(--text-muted); font-size:12px;">✅ Proceso completado</span>';
};

// Fetch KPIs
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (res.ok) {
      const stats = await res.json();
      document.getElementById('kpi-activos').textContent = stats.activos;
      document.getElementById('kpi-vistos').textContent = stats.porEstado['video_visto'] || 0;
      document.getElementById('kpi-reuniones').textContent = 
        (stats.porEstado['reunion_registrado'] || 0) + (stats.porEstado['reunion_asistio'] || 0);
      document.getElementById('kpi-conversion').textContent = stats.tasaConversion;
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

// Fetch tabla de leads
async function fetchLeads(estado = '') {
  document.getElementById('table-title').textContent = estado ? `Leads: ${formatEstado(estado)}` : 'Todos los Leads';
  
  const tbody = document.getElementById('leads-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center">Cargando...</td></tr>';

  try {
    const url = estado ? `/api/leads?estado=${estado}` : '/api/leads';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Network error');
    
    const data = await res.json();
    
    if (data.leads.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center">No hay leads para mostrar</td></tr>';
      return;
    }

    tbody.innerHTML = data.leads.map(lead => `
      <tr>
        <td>
          <strong>${lead.nombre}</strong><br>
          <small style="color:var(--text-muted)">ID: ${lead.id.split('-')[0]}...</small>
        </td>
        <td>${lead.telefono}</td>
        <td><span class="badge ${getBadgeClass(lead.estado)}">${formatEstado(lead.estado)}</span></td>
        <td>${formatFecha(lead.createdAt)}</td>
        <td>
          ${getActionButtons(lead.id, lead.estado)}
        </td>
      </tr>
    `).join('');

  } catch (err) {
    console.error('Error fetching leads:', err);
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#ef4444">Error al cargar datos</td></tr>';
  }
}

// Handler para simular transiciones completas
async function simulateAction(leadId, tipo) {
  let url = '';
  let body = {};
  let mensaje = '';
  
  if (tipo === 'video') {
    mensaje = '¿Simular clic en el vídeo VSL para este usuario?';
    url = '/tracking/video-click';
    body = { leadId };
  } else if (tipo === 'reunion') {
    mensaje = '¿Simular registro en la reunión grupal para este usuario?';
    url = '/tracking/reunion-registro';
    body = { leadId };
  } else if (tipo === 'asistencia') {
    mensaje = '¿Simular Asistencia por Zoom (Cierre) para este usuario?';
    url = '/webhook/zoom-attendance';
    body = { leadId, attended: true };
  }

  if(confirm(mensaje)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      
      if (res.ok) {
        alert('✨ ' + (data.message || 'Estado actualizado y WhatsApp enviado con éxito.'));
      } else {
        alert('❌ Error: ' + data.error);
      }
      
      fetchLeads();
      fetchStats();
    } catch (err) {
      alert('Error de red en simulación');
    }
  }
}
