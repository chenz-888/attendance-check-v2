const profileKey = "attendance-profile-v2";
const els = {
  form: document.querySelector("#profileForm"),
  name: document.querySelector("#name"),
  college: document.querySelector("#college"),
  personId: document.querySelector("#personId"),
  resetProfile: document.querySelector("#resetProfile"),
  currentName: document.querySelector("#currentName"),
  currentCollege: document.querySelector("#currentCollege"),
  currentId: document.querySelector("#currentId"),
  checkIn: document.querySelector("#checkIn"),
  checkOut: document.querySelector("#checkOut"),
  message: document.querySelector("#message"),
  clock: document.querySelector("#clock"),
  dateLine: document.querySelector("#dateLine")
};

const pad = value => String(value).padStart(2, "0");

function loadProfile() {
  return JSON.parse(localStorage.getItem(profileKey) || "null");
}

function saveProfile(profile) {
  localStorage.setItem(profileKey, JSON.stringify(profile));
}

function setMessage(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle("error", isError);
}

function setBusy(isBusy) {
  els.checkIn.disabled = isBusy || !loadProfile();
  els.checkOut.disabled = isBusy || !loadProfile();
}

function updateProfileView() {
  const profile = loadProfile();
  els.name.value = profile?.name || "";
  els.college.value = profile?.college || "";
  els.personId.value = profile?.personId || "";
  els.currentName.textContent = profile?.name || "未登记";
  els.currentCollege.textContent = profile?.college || "未登记";
  els.currentId.textContent = profile?.personId || "未登记";
  setBusy(false);
}

function updateClock() {
  const now = new Date();
  els.clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  els.dateLine.textContent = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(now);
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("当前浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    });
  });
}

async function punch(type) {
  const profile = loadProfile();
  if (!profile?.name || !profile?.personId) {
    setMessage("请先保存姓名和学号/工号。", true);
    return;
  }

  setBusy(true);
  setMessage("正在获取当前位置，请允许浏览器定位。");

  try {
    const position = await getLocation();
    const response = await fetch("/api/punch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        name: profile.name,
        college: profile.college,
        personId: profile.personId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "提交失败");
    setMessage(`${type}成功，后台已保存记录。`);
  } catch (error) {
    const message = error.code === 1
      ? "定位权限被拒绝，请在浏览器设置中允许访问位置。"
      : error.message || "提交失败，请稍后重试。";
    setMessage(message, true);
  } finally {
    setBusy(false);
  }
}

els.form.addEventListener("submit", event => {
  event.preventDefault();
  const profile = {
    name: els.name.value.trim(),
    college: els.college.value.trim(),
    personId: els.personId.value.trim()
  };
  if (!profile.name || !profile.college || !profile.personId) {
    setMessage("姓名、学院和学号/工号都需要填写。", true);
    return;
  }
  saveProfile(profile);
  updateProfileView();
  setMessage("身份已保存，可以开始签到。");
});

els.resetProfile.addEventListener("click", () => {
  localStorage.removeItem(profileKey);
  updateProfileView();
  setMessage("已清除当前身份，请重新填写。");
  els.name.focus();
});

els.checkIn.addEventListener("click", () => punch("签到"));
els.checkOut.addEventListener("click", () => punch("签退"));

updateClock();
setInterval(updateClock, 1000);
updateProfileView();
