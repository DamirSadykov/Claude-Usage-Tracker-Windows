class Notifier { sendSms(text) { const phone = this.getPhone(); this.send(phone, text); } getPhone() { return ""; } send() {} validatePhone() { return true; } }
