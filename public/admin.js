const els = {
  form: document.querySelector("#adminForm"),
  password: document.querySelector("#password"),
  exportCsv: document.querySelector("#exportCsv"),
  message: document.querySelector("#message"),
  recordBody: document.querySelector("#recordBody"),
  empty: document.querySelector("#empty")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle("error", isError);
}

function getPassword() {
  return els.password.value || sessionStorage.getItem("attendance-admin-password") || "";
}

async function loadRecords() {
  const password = getPassword();
  if (!password) {
    setMessage("请输入管理员密码。", true);
    return;
  }

  let result;
  try {
    const response = await fetch("/api/records", {
      headers: { "x-admin-password": password }
    });
    result = await response.json();
    if (!result.ok) {
      setMessage(result.error || "读取失败", true);
      return;
    }
  } catch {
    setMessage("后台连接失败，请稍后重试。", true);
    return;
  }

  sessionStorage.setItem("attendance-admin-password", password);
  renderRecords(result.records);
  setMessage(`共 ${result.records.length} 条记录。后台会每 10 秒自动刷新。`);
}

function renderRecords(records) {
  els.recordBody.innerHTML = "";
  els.empty.style.display = records.length ? "none" : "block";
  for (const record of records) {
    const row = document.createElement("tr");
    const tagClass = record.type === "签到" ? "in" : "out";
    const mapUrl = `https://maps.google.com/?q=${record.latitude},${record.longitude}`;
    row.innerHTML = `
      <td><span class="tag ${tagClass}">${escapeHtml(record.type)}</span></td>
      <td>${escapeHtml(record.name)}</td>
      <td>${escapeHtml(record.college)}</td>
      <td>${escapeHtml(record.personId)}</td>
      <td>${formatDateTime(record.time)}</td>
      <td><a class="map" href="${mapUrl}" target="_blank" rel="noreferrer">${Number(record.latitude).toFixed(6)}, ${Number(record.longitude).toFixed(6)}</a></td>
      <td>约 ${escapeHtml(record.accuracy)} 米</td>
      <td>${escapeHtml(record.ip)}</td>
    `;
    els.recordBody.appendChild(row);
  }
}

els.form.addEventListener("submit", event => {
  event.preventDefault();
  loadRecords();
});

els.exportCsv.addEventListener("click", () => {
  const password = getPassword();
  if (!password) {
    setMessage("请输入管理员密码。", true);
    return;
  }
  fetch("/api/records.csv", { headers: { "x-admin-password": password } })
    .then(response => response.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "attendance-records.csv";
      link.click();
      URL.revokeObjectURL(url);
    })
    .catch(() => setMessage("导出失败。", true));
});

const savedPassword = sessionStorage.getItem("attendance-admin-password");
if (savedPassword) {
  els.password.value = savedPassword;
  loadRecords();
}

setInterval(() => {
  if (getPassword()) {
    loadRecords();
  }
}, 10000);
