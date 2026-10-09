class Notifier { sendSms(text) { const phone = this.getPhone(); if (this.validatePhone(phone)) { this.send(phone, text); } } getPhone() { return ""; } send() {} validatePhone() { return true; } }
