class Notifier { sendSms(text) { const phone = "79990000000"; if (!this.validatePhone(phone)) return; this.send(phone, text); } getPhone() { return ""; } send() {} validatePhone() { return true; } }
