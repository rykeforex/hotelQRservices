/**
 * report-engine.js
 *
 * Generates executive-grade PDF reports for the Hotel Admin Portal.
 * Every report gets a branded cover page (hotel logo + brand colors),
 * real metrics pulled live from the database, and a copyright footer
 * on every page. No placeholder data, no generic filler.
 */
const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 50;

const REPORT_TYPES = {
  executive_summary: {
    title: 'Executive Summary',
    subtitle: 'Full operational overview',
    sections: ['kpis', 'requestChart', 'departmentTable', 'staffTable', 'insights']
  },
  staff_performance: {
    title: 'Staff Performance Report',
    subtitle: 'Individual staff output and standing',
    sections: ['kpis', 'staffTable', 'insights']
  },
  department_performance: {
    title: 'Department Performance Report',
    subtitle: 'Department-by-department comparison',
    sections: ['kpis', 'departmentTable', 'requestChart', 'insights']
  },
  request_summary: {
    title: 'Request Analysis Report',
    subtitle: 'Guest service request volume and status',
    sections: ['kpis', 'requestChart', 'statusBreakdown', 'insights']
  },
  completion_rates: {
    title: 'Completion Rates Report',
    subtitle: 'Resolution performance by department',
    sections: ['kpis', 'departmentTable', 'insights']
  },
  user_activity: {
    title: 'User Activity Report',
    subtitle: 'Staff account activity summary',
    sections: ['kpis', 'staffTable', 'insights']
  },
  attendance_report: {
    title: 'Attendance Report',
    subtitle: 'Clock-in reliability and coverage',
    sections: ['attendanceKpis', 'attendanceTable', 'insights']
  },
  leave_report: {
    title: 'Leave Report',
    subtitle: 'Leave requests and approvals',
    sections: ['leaveKpis', 'leaveTable', 'insights']
  },
  shift_performance_report: {
    title: 'Shift Performance Report',
    subtitle: 'Coverage, conflicts, and vacancy',
    sections: ['shiftKpis', 'shiftCoverageTable', 'insights']
  }
};

// ---------- color helpers ----------
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function toHex(rgb) {
  return '#' + [rgb.r, rgb.g, rgb.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function shade(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const adjust = c => (amount > 0 ? c + (255 - c) * amount : c + c * amount);
  return toHex({ r: adjust(rgb.r), g: adjust(rgb.g), b: adjust(rgb.b) });
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch (err) {
    return null;
  }
}

// ---------- data collection ----------
async function collectMetrics(pool, hotelId, periodDays) {
  const [hotelRes, staffRes, deptRes, reqRes, byServiceRes, byDayRes, staffPerfRes] = await Promise.all([
    pool.query(`SELECT * FROM hotels WHERE id = $1`, [hotelId]),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_online = TRUE)::int AS online,
              COUNT(*) FILTER (WHERE created_at >= NOW() - ($2 || ' days')::interval)::int AS new_recent,
              COUNT(*) FILTER (WHERE account_status = 'locked')::int AS locked
       FROM hotel_admin_users WHERE hotel_id = $1 AND deleted_at IS NULL`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT d.id, d.name, d.status, COUNT(u.id)::int AS staff_count
       FROM hotel_admin_departments d
       LEFT JOIN hotel_admin_users u ON u.department_id = d.id AND u.deleted_at IS NULL
       WHERE d.hotel_id = $1 GROUP BY d.id ORDER BY d.name`,
      [hotelId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'in-progress')::int AS in_progress,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE status = 'completed')), 0)::int AS avg_response
       FROM requests WHERE hotel_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT COALESCE(service,'Unspecified') AS service, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM requests WHERE hotel_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY service ORDER BY total DESC`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS total
       FROM requests WHERE hotel_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY day ORDER BY day`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT u.full_name, d.name AS department_name,
              COUNT(a.id) FILTER (WHERE a.action IN ('request_completed','complete_requests'))::int AS completed,
              COUNT(a.id) FILTER (WHERE a.action ILIKE '%escalat%')::int AS escalated
       FROM hotel_admin_users u
       LEFT JOIN hotel_admin_departments d ON d.id = u.department_id
       LEFT JOIN hotel_admin_audit_logs a ON a.actor_user_id = u.id AND a.created_at >= NOW() - ($2 || ' days')::interval
       WHERE u.hotel_id = $1 AND u.deleted_at IS NULL
       GROUP BY u.id, d.name, u.full_name
       ORDER BY completed DESC, u.full_name LIMIT 10`,
      [hotelId, periodDays]
    )
  ]);

  const hotel = hotelRes.rows[0] || {};
  const staff = staffRes.rows[0] || {};
  const req = reqRes.rows[0] || {};
  const completionRate = req.total > 0 ? Math.round((req.completed / req.total) * 100) : 0;

  // Best-effort match between admin-managed departments and guest-facing
  // request `service` categories (two separate concepts in this system).
  const departments = deptRes.rows.map(d => {
    const match = byServiceRes.rows.find(s => s.service.toLowerCase().includes(d.name.toLowerCase().split(' ')[0]) || d.name.toLowerCase().includes(s.service.toLowerCase()));
    const total = match ? match.total : 0;
    const completed = match ? match.completed : 0;
    return {
      name: d.name,
      status: d.status,
      staffCount: d.staff_count,
      requests: total,
      completed,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : null
    };
  });

  return {
    hotel,
    metrics: {
      totalStaff: staff.total || 0,
      onlineStaff: staff.online || 0,
      newStaff: staff.new_recent || 0,
      lockedAccounts: staff.locked || 0,
      activeDepartments: departments.filter(d => d.status === 'active').length,
      totalDepartments: departments.length,
      totalRequests: req.total || 0,
      completedRequests: req.completed || 0,
      pendingRequests: req.pending || 0,
      inProgressRequests: req.in_progress || 0,
      avgResponseMinutes: req.avg_response || 0,
      completionRate
    },
    departments,
    byService: byServiceRes.rows,
    byDay: byDayRes.rows,
    staffPerformance: staffPerfRes.rows
  };
}

async function collectWorkforceExtras(pool, hotelId, periodDays) {
  const [attendanceSummaryRes, attendanceByEmployeeRes, leaveSummaryRes, leaveListRes, shiftSummaryRes, coverageRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE status = 'late')::int AS late,
              COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
              COUNT(*) FILTER (WHERE status = 'half-day')::int AS half_day,
              COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600) FILTER (WHERE clock_in IS NOT NULL AND clock_out IS NOT NULL), 1), 0) AS avg_hours
       FROM hotel_admin_attendance WHERE hotel_id = $1 AND attendance_date >= NOW() - ($2 || ' days')::interval`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT u.full_name, d.name AS department_name,
              COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
              COUNT(*) FILTER (WHERE a.status = 'late')::int AS late,
              COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent,
              COUNT(*)::int AS total
       FROM hotel_admin_attendance a
       JOIN hotel_admin_users u ON u.id = a.user_id AND u.deleted_at IS NULL
       LEFT JOIN hotel_admin_departments d ON d.id = u.department_id
       WHERE a.hotel_id = $1 AND a.attendance_date >= NOW() - ($2 || ' days')::interval
       GROUP BY u.id, u.full_name, d.name ORDER BY late DESC, absent DESC LIMIT 15`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT leave_type, status, COUNT(*)::int AS count
       FROM hotel_admin_leave_requests WHERE hotel_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY leave_type, status`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT l.leave_type, l.custom_type_label, l.start_date, l.end_date, l.status, u.full_name
       FROM hotel_admin_leave_requests l JOIN hotel_admin_users u ON u.id = l.user_id
       WHERE l.hotel_id = $1 AND l.created_at >= NOW() - ($2 || ' days')::interval
       ORDER BY l.start_date DESC LIMIT 20`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total_scheduled, COUNT(DISTINCT user_id)::int AS staff_scheduled
       FROM hotel_admin_shift_schedule WHERE hotel_id = $1 AND shift_date >= NOW() - ($2 || ' days')::interval`,
      [hotelId, periodDays]
    ),
    pool.query(
      `SELECT s.name, s.start_time, s.end_time, COUNT(sc.id)::int AS scheduled_count
       FROM hotel_admin_shifts s
       LEFT JOIN hotel_admin_shift_schedule sc ON sc.shift_id = s.id AND sc.shift_date >= NOW() - ($2 || ' days')::interval
       WHERE s.hotel_id = $1 GROUP BY s.id ORDER BY s.name`,
      [hotelId, periodDays]
    )
  ]);

  const leaveTotals = leaveSummaryRes.rows.reduce((acc, row) => {
    acc.total += row.count;
    acc[row.status] = (acc[row.status] || 0) + row.count;
    return acc;
  }, { total: 0, pending: 0, approved: 0, rejected: 0 });

  const attendance = attendanceSummaryRes.rows[0] || {};
  const attendanceRate = attendance.total > 0 ? Math.round(((attendance.present + attendance.late + attendance.half_day) / attendance.total) * 100) : 0;

  return {
    attendance: { ...attendance, attendanceRate, byEmployee: attendanceByEmployeeRes.rows },
    leave: { totals: leaveTotals, byType: leaveSummaryRes.rows, list: leaveListRes.rows },
    shifts: { ...shiftSummaryRes.rows[0], coverage: coverageRes.rows }
  };
}

function bucketByDay(byDay, periodDays) {
  const targetBuckets = Math.min(10, Math.max(1, byDay.length || 1));
  if (byDay.length <= 10) {
    return byDay.map(row => ({ label: new Date(row.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), total: row.total }));
  }
  const chunkSize = Math.ceil(byDay.length / targetBuckets);
  const buckets = [];
  for (let i = 0; i < byDay.length; i += chunkSize) {
    const chunk = byDay.slice(i, i + chunkSize);
    const total = chunk.reduce((sum, r) => sum + r.total, 0);
    const start = new Date(chunk[0].day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    buckets.push({ label: start, total });
  }
  return buckets;
}

function buildInsights(data) {
  const { metrics, departments, byService } = data;
  const insights = [];

  if (byService.length) {
    const busiest = byService[0];
    insights.push(`${busiest.service} generated the highest request volume this period, with ${busiest.total} requests (${busiest.total > 0 ? Math.round((busiest.completed / busiest.total) * 100) : 0}% completed).`);
  }
  const rated = departments.filter(d => d.completionRate !== null).sort((a, b) => b.completionRate - a.completionRate);
  if (rated.length) {
    insights.push(`${rated[0].name} leads on completion rate at ${rated[0].completionRate}%${rated.length > 1 ? `, ahead of ${rated[rated.length - 1].name} at ${rated[rated.length - 1].completionRate}%.` : '.'}`);
  }
  insights.push(`Average response time across all requests was ${metrics.avgResponseMinutes} minutes, with an overall completion rate of ${metrics.completionRate}%.`);
  if (metrics.lockedAccounts > 0) {
    insights.push(`${metrics.lockedAccounts} staff account${metrics.lockedAccounts === 1 ? ' is' : 's are'} currently locked and may need administrator attention.`);
  }
  const understaffed = departments.filter(d => d.staffCount === 0 && d.status === 'active');
  if (understaffed.length) {
    insights.push(`${understaffed.map(d => d.name).join(', ')} ${understaffed.length === 1 ? 'has' : 'have'} no staff currently assigned despite being active.`);
  }
  if (metrics.pendingRequests > metrics.completedRequests && metrics.totalRequests > 0) {
    insights.push(`Pending requests (${metrics.pendingRequests}) currently exceed completions (${metrics.completedRequests}) for this period — consider reviewing staffing coverage during peak hours.`);
  }
  return insights;
}

// ---------- drawing helpers ----------
function drawFooter(doc, pageWidth, pageHeight, pageNum, totalPages) {
  const y = pageHeight - 38;
  doc.lineWidth(0.5).strokeColor('#d9d2bf').moveTo(PAGE_MARGIN, y).lineTo(pageWidth - PAGE_MARGIN, y).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor('#8a8070');
  doc.text('© Peerloom Technologies Limited  ·  Generated by the QUORVA Hospitality Platform', PAGE_MARGIN, y + 8, { width: pageWidth - PAGE_MARGIN * 2 - 60, align: 'left' });
  doc.text(`Page ${pageNum} of ${totalPages}`, pageWidth - PAGE_MARGIN - 80, y + 8, { width: 80, align: 'right' });
}

function drawCoverPage(doc, { hotel, primary, secondary, logoBuffer, reportTitle, subtitle, periodLabel, preparedFor, generatedDate }) {
  const { width, height } = doc.page;
  doc.rect(0, 0, width, height).fill(secondary);
  // Soft diagonal gold wash
  doc.save();
  doc.opacity(0.08);
  doc.polygon([width * 0.35, 0], [width, 0], [width, height * 0.65]).fill(primary);
  doc.restore();

  doc.rect(0, height - 10, width, 10).fill(primary);

  const centerX = width / 2;
  let cursorY = height * 0.24;

  if (logoBuffer) {
    try {
      const size = 84;
      doc.circle(centerX, cursorY + size / 2, size / 2 + 6).lineWidth(1.5).strokeColor(primary).stroke();
      doc.image(logoBuffer, centerX - size / 2, cursorY, { width: size, height: size, fit: [size, size] });
      cursorY += size + 36;
    } catch (err) {
      cursorY += 20;
    }
  } else {
    const size = 84;
    doc.circle(centerX, cursorY + size / 2, size / 2).fill(primary);
    doc.fillColor(secondary).font('Times-Bold').fontSize(38)
      .text((hotel.name || 'H').trim().charAt(0).toUpperCase(), centerX - size / 2, cursorY + size / 2 - 19, { width: size, align: 'center' });
    cursorY += size + 36;
  }

  doc.fillColor('#f4efe3').font('Times-Roman').fontSize(11)
    .text((hotel.name || 'Your Hotel').toUpperCase(), 0, cursorY, { width, align: 'center', characterSpacing: 3 });
  cursorY += 34;

  doc.strokeColor(primary).lineWidth(1).moveTo(centerX - 40, cursorY).lineTo(centerX + 40, cursorY).stroke();
  cursorY += 30;

  doc.fillColor('#ffffff').font('Times-Bold').fontSize(34)
    .text(reportTitle, 60, cursorY, { width: width - 120, align: 'center' });
  cursorY += 50;

  doc.fillColor(shade(primary, 0.35)).font('Helvetica').fontSize(12)
    .text(subtitle, 60, cursorY, { width: width - 120, align: 'center' });
  cursorY += 60;

  const infoRows = [
    ['Reporting Period', periodLabel],
    ['Prepared For', preparedFor],
    ['Generated', generatedDate],
    ['Prepared By', 'QUORVA Hospitality Platform']
  ];
  const boxWidth = 320;
  const boxX = centerX - boxWidth / 2;
  doc.font('Helvetica').fontSize(10);
  infoRows.forEach((row, i) => {
    const rowY = cursorY + i * 22;
    doc.fillColor(shade(primary, 0.3)).text(row[0].toUpperCase(), boxX, rowY, { width: 150, characterSpacing: 0.5 });
    doc.fillColor('#f4efe3').text(row[1], boxX + 150, rowY, { width: boxWidth - 150, align: 'right' });
  });

  doc.fillColor(shade(primary, 0.2)).font('Helvetica').fontSize(8.5)
    .text('© Peerloom Technologies Limited', 0, height - 30, { width, align: 'center', characterSpacing: 1 });
}

function sectionHeading(doc, text, primary) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.6);
  doc.font('Times-Bold').fontSize(18).fillColor('#1b1810').text(text);
  doc.moveTo(doc.x, doc.y + 4).lineTo(doc.x + 42, doc.y + 4).lineWidth(2).strokeColor(primary).stroke();
  doc.moveDown(0.9);
}

function drawKpiGrid(doc, kpis, primary) {
  if (!kpis.length) return;
  const cols = 3;
  const gap = 14;
  const totalWidth = doc.page.width - PAGE_MARGIN * 2;
  const cardWidth = (totalWidth - gap * (cols - 1)) / cols;
  const cardHeight = 66;
  const rows = Math.ceil(kpis.length / cols);
  const gridHeight = rows * cardHeight + (rows - 1) * gap;

  if (doc.y + gridHeight > doc.page.height - 90) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  }

  const startY = doc.y;
  kpis.forEach((kpi, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = PAGE_MARGIN + col * (cardWidth + gap);
    const y = startY + row * (cardHeight + gap);
    doc.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke('#faf7ef', '#e7dfc8');
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(20).text(String(kpi.value), x + 14, y + 14, { width: cardWidth - 28 });
    doc.fillColor('#8a8070').font('Helvetica').fontSize(8).text(kpi.label.toUpperCase(), x + 14, y + 40, { width: cardWidth - 28, characterSpacing: 0.4 });
  });

  doc.y = startY + gridHeight;
  doc.moveDown(0.5);
}

function drawBarChart(doc, buckets, primary) {
  if (!buckets.length) {
    doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No request activity recorded for this period.');
    doc.moveDown();
    return;
  }
  const chartWidth = doc.page.width - PAGE_MARGIN * 2;
  const chartHeight = 140;
  if (doc.y + chartHeight + 40 > doc.page.height - 90) doc.addPage();
  const baseY = doc.y + chartHeight;
  const max = Math.max(...buckets.map(b => b.total), 1);
  const barGap = 10;
  const barWidth = (chartWidth - barGap * (buckets.length - 1)) / buckets.length;

  doc.strokeColor('#e7dfc8').lineWidth(0.5).moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN, baseY).stroke();
  doc.moveTo(PAGE_MARGIN, baseY).lineTo(PAGE_MARGIN + chartWidth, baseY).stroke();

  buckets.forEach((b, i) => {
    const barHeight = max > 0 ? (b.total / max) * (chartHeight - 20) : 0;
    const x = PAGE_MARGIN + i * (barWidth + barGap);
    const y = baseY - barHeight;
    doc.roundedRect(x, y, barWidth, Math.max(barHeight, 1), 2).fill(primary);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#3a3630').text(String(b.total), x, y - 12, { width: barWidth, align: 'center' });
    doc.font('Helvetica').fontSize(7).fillColor('#8a8070').text(b.label, x, baseY + 6, { width: barWidth, align: 'center' });
  });
  doc.y = baseY + 24;
}

function drawTable(doc, headers, rows, colWidths, primary) {
  const startX = PAGE_MARGIN;
  const rowHeight = 22;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  function drawHeader() {
    doc.rect(startX, doc.y, tableWidth, rowHeight).fill(primary);
    let x = startX;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff');
    headers.forEach((h, i) => {
      doc.text(h.toUpperCase(), x + 8, doc.y - rowHeight + 7, { width: colWidths[i] - 12 });
      x += colWidths[i];
    });
    doc.y += rowHeight;
  }

  drawHeader();
  rows.forEach((row, rIdx) => {
    if (doc.y + rowHeight > doc.page.height - 90) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
      drawHeader();
    }
    if (rIdx % 2 === 1) doc.rect(startX, doc.y, tableWidth, rowHeight).fill('#faf7ef');
    let x = startX;
    doc.font('Helvetica').fontSize(9).fillColor('#3a3630');
    row.forEach((cell, i) => {
      doc.text(String(cell), x + 8, doc.y + 6, { width: colWidths[i] - 12 });
      x += colWidths[i];
    });
    doc.y += rowHeight;
  });
  doc.moveTo(startX, doc.y).lineTo(startX + tableWidth, doc.y).lineWidth(0.5).strokeColor('#e7dfc8').stroke();
  doc.moveDown(1);
}

// ---------- main entry point ----------
async function generateReportPdf({ pool, hotelId, hotelName, adminName, reportType, periodDays }) {
  const type = REPORT_TYPES[reportType] ? reportType : 'executive_summary';
  const config = REPORT_TYPES[type];
  const period = Number(periodDays) > 0 ? Number(periodDays) : 30;

  const data = await collectMetrics(pool, hotelId, period);
  const needsWorkforceExtras = config.sections.some(s => s.startsWith('attendance') || s.startsWith('leave') || s.startsWith('shift'));
  const extras = needsWorkforceExtras ? await collectWorkforceExtras(pool, hotelId, period) : null;
  const brandColors = data.hotel.brand_colors || {};
  const primary = brandColors.primary || '#c9a227';
  const secondary = brandColors.secondary || '#15130f';
  const logoBuffer = await fetchImageBuffer(data.hotel.logo_url);

  const now = new Date();
  const periodStart = new Date(now.getTime() - period * 24 * 60 * 60 * 1000);
  const periodLabel = `${periodStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const generatedDate = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true, info: {
    Title: `${config.title} — ${data.hotel.name || hotelName || 'Hotel'}`,
    Author: 'QUORVA Hospitality Platform · Peerloom Technologies Limited'
  }});

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ---- Cover page ----
  drawCoverPage(doc, {
    hotel: data.hotel, primary, secondary, logoBuffer,
    reportTitle: config.title, subtitle: config.subtitle,
    periodLabel, preparedFor: adminName || 'Hotel Administrator', generatedDate
  });

  // ---- Content pages ----
  doc.addPage();
  doc.y = PAGE_MARGIN;

  sectionHeading(doc, 'Executive Summary', primary);
  doc.font('Helvetica').fontSize(10.5).fillColor('#3a3630').text(
    `This report covers ${data.hotel.name || hotelName || 'the property'} for the period ${periodLabel}. ` +
    `During this window, the property recorded ${data.metrics.totalRequests} guest service requests across ${data.departments.length} department${data.departments.length === 1 ? '' : 's'}, ` +
    `completing ${data.metrics.completedRequests} (${data.metrics.completionRate}%) with an average response time of ${data.metrics.avgResponseMinutes} minutes. ` +
    `The team currently stands at ${data.metrics.totalStaff} active staff members, ${data.metrics.onlineStaff} of whom are online at time of generation.`,
    { align: 'left', lineGap: 3 }
  );
  doc.moveDown(1);

  if (config.sections.includes('kpis')) {
    sectionHeading(doc, 'Key Performance Indicators', primary);
    drawKpiGrid(doc, [
      { label: 'Total Staff', value: data.metrics.totalStaff },
      { label: 'Active Departments', value: data.metrics.activeDepartments },
      { label: 'Total Requests', value: data.metrics.totalRequests },
      { label: 'Completed', value: data.metrics.completedRequests },
      { label: 'Pending', value: data.metrics.pendingRequests },
      { label: 'In Progress', value: data.metrics.inProgressRequests },
      { label: 'Avg Response (min)', value: data.metrics.avgResponseMinutes },
      { label: 'Completion Rate', value: `${data.metrics.completionRate}%` },
      { label: 'New Staff (period)', value: data.metrics.newStaff }
    ], primary);
    doc.moveDown(0.5);
  }

  if (config.sections.includes('requestChart')) {
    sectionHeading(doc, 'Request Volume Over Time', primary);
    drawBarChart(doc, bucketByDay(data.byDay, period), primary);
  }

  if (config.sections.includes('statusBreakdown')) {
    sectionHeading(doc, 'Request Status Breakdown', primary);
    drawTable(doc,
      ['Status', 'Count', 'Share'],
      [
        ['Completed', data.metrics.completedRequests, `${data.metrics.totalRequests ? Math.round(data.metrics.completedRequests / data.metrics.totalRequests * 100) : 0}%`],
        ['Pending', data.metrics.pendingRequests, `${data.metrics.totalRequests ? Math.round(data.metrics.pendingRequests / data.metrics.totalRequests * 100) : 0}%`],
        ['In Progress', data.metrics.inProgressRequests, `${data.metrics.totalRequests ? Math.round(data.metrics.inProgressRequests / data.metrics.totalRequests * 100) : 0}%`]
      ],
      [200, 150, 194], primary
    );
  }

  if (config.sections.includes('departmentTable')) {
    sectionHeading(doc, 'Department Comparison', primary);
    if (data.departments.length) {
      drawTable(doc,
        ['Department', 'Status', 'Staff', 'Requests', 'Completion'],
        data.departments.map(d => [d.name, d.status, d.staffCount, d.requests, d.completionRate === null ? '—' : `${d.completionRate}%`]),
        [160, 90, 70, 90, 134], primary
      );
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No departments configured yet.');
      doc.moveDown();
    }
  }

  if (config.sections.includes('staffTable')) {
    sectionHeading(doc, 'Top Performing Staff', primary);
    if (data.staffPerformance.length) {
      drawTable(doc,
        ['Staff Member', 'Department', 'Completed', 'Escalated'],
        data.staffPerformance.map(s => [s.full_name, s.department_name || 'Unassigned', s.completed, s.escalated]),
        [180, 150, 90, 124], primary
      );
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No staff activity recorded for this period.');
      doc.moveDown();
    }
  }

  if (config.sections.includes('insights')) {
    sectionHeading(doc, 'Insights & Recommendations', primary);
    const insights = buildInsights(data);
    if (insights.length) {
      insights.forEach(line => {
        if (doc.y > doc.page.height - 100) doc.addPage();
        doc.font('Helvetica').fontSize(10).fillColor('#3a3630');
        doc.circle(PAGE_MARGIN + 3, doc.y + 6, 2).fill(primary);
        doc.text(line, PAGE_MARGIN + 14, doc.y, { width: doc.page.width - PAGE_MARGIN * 2 - 14, lineGap: 3 });
        doc.moveDown(0.6);
      });
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No notable patterns detected for this period.');
    }
  }

  if (config.sections.includes('attendanceKpis')) {
    sectionHeading(doc, 'Attendance Overview', primary);
    drawKpiGrid(doc, [
      { label: 'Attendance Rate', value: `${extras.attendance.attendanceRate}%` },
      { label: 'Present', value: extras.attendance.present || 0 },
      { label: 'Late', value: extras.attendance.late || 0 },
      { label: 'Absent', value: extras.attendance.absent || 0 },
      { label: 'Half-day', value: extras.attendance.half_day || 0 },
      { label: 'Avg Hours Worked', value: extras.attendance.avg_hours || 0 }
    ], primary);
    doc.moveDown(0.5);
  }

  if (config.sections.includes('attendanceTable')) {
    sectionHeading(doc, 'Attendance by Employee', primary);
    if (extras.attendance.byEmployee.length) {
      drawTable(doc,
        ['Employee', 'Department', 'Present', 'Late', 'Absent'],
        extras.attendance.byEmployee.map(e => [e.full_name, e.department_name || 'Unassigned', e.present, e.late, e.absent]),
        [160, 130, 78, 78, 78], primary
      );
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No attendance records for this period.');
      doc.moveDown();
    }
  }

  if (config.sections.includes('leaveKpis')) {
    sectionHeading(doc, 'Leave Overview', primary);
    drawKpiGrid(doc, [
      { label: 'Total Requests', value: extras.leave.totals.total },
      { label: 'Approved', value: extras.leave.totals.approved || 0 },
      { label: 'Pending', value: extras.leave.totals.pending || 0 },
      { label: 'Rejected', value: extras.leave.totals.rejected || 0 }
    ], primary);
    doc.moveDown(0.5);
  }

  if (config.sections.includes('leaveTable')) {
    sectionHeading(doc, 'Leave Requests', primary);
    if (extras.leave.list.length) {
      drawTable(doc,
        ['Employee', 'Type', 'Start', 'End', 'Status'],
        extras.leave.list.map(l => [l.full_name, l.custom_type_label || l.leave_type, l.start_date.toISOString().slice(0, 10), l.end_date.toISOString().slice(0, 10), l.status]),
        [140, 110, 90, 90, 94], primary
      );
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No leave requests for this period.');
      doc.moveDown();
    }
  }

  if (config.sections.includes('shiftKpis')) {
    sectionHeading(doc, 'Shift Coverage Overview', primary);
    drawKpiGrid(doc, [
      { label: 'Total Scheduled', value: extras.shifts.total_scheduled || 0 },
      { label: 'Staff Scheduled', value: extras.shifts.staff_scheduled || 0 },
      { label: 'Shift Templates', value: extras.shifts.coverage.length }
    ], primary);
    doc.moveDown(0.5);
  }

  if (config.sections.includes('shiftCoverageTable')) {
    sectionHeading(doc, 'Coverage by Shift', primary);
    if (extras.shifts.coverage.length) {
      drawTable(doc,
        ['Shift', 'Hours', 'Times Scheduled (period)'],
        extras.shifts.coverage.map(s => [s.name, `${s.start_time || '—'} - ${s.end_time || '—'}`, s.scheduled_count]),
        [180, 180, 152], primary
      );
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#8a8070').text('No shift templates configured yet.');
      doc.moveDown();
    }
  }

  // ---- Footer + page numbers on every page ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i === range.start) continue; // skip footer text clutter on the cover page proper, but keep numbering off it
    drawFooter(doc, doc.page.width, doc.page.height, i - range.start + 1, range.count);
  }

  doc.end();
  return done;
}

module.exports = { generateReportPdf, REPORT_TYPES };