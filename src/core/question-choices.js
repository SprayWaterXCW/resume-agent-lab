/** Explicit, local answer transformations. The model never sees private values. */
export function questionChoiceValue(field, sourcePath, value) {
  const text = String(field.label || "").normalize("NFKC").replace(/[\s:：?？]/g, "");
  const preferenceQuestion = sourcePath === "jobPreferences.acceptShiftWork" ? /轮班|倒班/
    : sourcePath === "jobPreferences.acceptCleanroomWork" ? /无尘.*(?:车间|工作)/
    : sourcePath === "jobPreferences.acceptRoleAdjustment" ? /岗位.*调剂|调剂.*岗位/ : null;
  if (preferenceQuestion?.test(text) && !field.questionContext) {
    // A boolean preference is already confirmed by the user. Translate only
    // between unambiguous, present, paired options; never infer a preference.
    const answer = String(value || "").trim(), positive = ["是", "能", "接受", "愿意", "可以"], negative = ["否", "不能", "不接受", "不愿意", "不可以"];
    const options = field.choiceOptions || [];
    for (const [yes, no] of [["是", "否"], ["能", "不能"], ["接受", "不接受"], ["愿意", "不愿意"], ["可以", "不可以"]]) {
      if (options.includes(yes) && options.includes(no)) return positive.includes(answer) ? yes : negative.includes(answer) ? no : value;
    }
    return value;
  }
  if (sourcePath !== "personal.colorVision" || !/色盲|色弱/.test(text)) return value;
  // A descriptive color-vision answer is not itself an option in a yes/no question.
  // Keep detail fields and unknown/withheld answers unchanged, never infer health.
  if (!/^(?:您|你)?是否(?:有|存在|患有).*(?:色盲|色弱)/.test(text)) return value;
  const answer = String(value || "").trim();
  if (["无色盲色弱", "无色盲/色弱", "无色盲、色弱"].includes(answer)) return "否";
  if (["色盲", "色弱", "色盲色弱"].includes(answer)) return "是";
  return value;
}

export const normalizeQuestion = (value) => String(value || "").normalize("NFKC")
  .replace(/[\s\p{P}＊*]/gu, "").toLowerCase();

export function questionKey(field) {
  return normalizeQuestion([field.questionContext, field.label].filter(Boolean).join(" / "));
}

/** Editor destinations are suggestions for the user, never automatic fill mappings. */
export function configurationFor(field) {
  const text = String(field.label || "").trim().replace(/[\s:：＊*]+$/g, "");
  const matches = [
    [/^(?:姓名|全名|full name)$/i, "personal", "fullName"],
    [/^(?:性别|gender|sex)$/i, "personal", "gender"],
    [/^(?:手机号|手机号码|联系电话|mobile(?: phone)?|phone(?: number)?)$/i, "personal", "phoneNumber"],
    [/^(?:邮箱|电子邮箱|电子邮件|e-?mail(?: address)?)$/i, "personal", "email"],
    [/^(?:身高|height)(?:[（(].*[）)])?$/i, "personal", "heightCm"],
    [/^(?:体重|weight)(?:[（(].*[）)])?$/i, "personal", "weightKg"],
    [/^(?:出生日期|出生年月|生日|date of birth|birth date|birthday)$/i, "personal", "birthDate"],
    [/^(?:通讯地址|通信地址|联系地址|现居地址|居住地址|mailing address|contact address)$/i, "contactAndLocation", "currentAddressLine1"],
    [/^(?:邮政编码|邮编|postal code|zip code)$/i, "contactAndLocation", "postalCode"],
    [/^(?:国籍|nationality|citizenship)$/i, "personal", "nationality"],
    [/^(?:民族|ethnicity)$/i, "personal", "ethnicity"],
    [/^(?:英语等级|english level)$/i, "languages", "testScore"],
    [/^(?:英语等级成绩|英语成绩|english score)$/i, "languages", "testScore"],
    [/^(?:学习形式|学习方式|培养方式|study mode)$/i, "educations", "studyMode"],
    [/色盲|色弱/, "personal", "colorVision"],
    [/^(?:最高学历)?专业(?:类别|分类)|^学科类别/, "educations", "majorCategory"],
    [/校区/, "educations", "campus"],
    [/预计.*毕业.*(?:日期|时间)|预期.*毕业/, "educations", "endDate"],
    [/预计.*实习.*(?:日期|时间)/, "jobPreferences", "availableInternshipDate"],
    [/期望.*(?:月薪|月工资|薪.*月)|expected.*monthly/i, "jobPreferences", "expectedMonthlySalary"],
    [/期望.*(?:年薪|年工资|薪.*年)|expected.*annual/i, "jobPreferences", "expectedAnnualSalary"],
    [/^籍贯/, "contactAndLocation", "hometownProvince"],
    [/推荐人工号/, "jobPreferences", "referrerEmployeeId"],
    [/推荐人.*(?:姓名|名字)/, "jobPreferences", "referrerName"],
    [/内推码|推荐码/, "jobPreferences", "referralCode"],
    [/岗位.*调剂|调剂.*岗位/, "jobPreferences", "acceptRoleAdjustment"],
    [/轮班|倒班/, "jobPreferences", "acceptShiftWork"],
    [/无尘.*(?:车间|工作)/, "jobPreferences", "acceptCleanroomWork"],
    [/最看重.*(?:方面|因素)|择业.*考虑/, "jobPreferences", "jobPriorities"],
    [/职业生涯规划|职业规划/, "jobPreferences", "careerPlan"],
    [/个性.*(?:词|特点)|性格.*(?:词|特点)/, "skills", "personalityKeywords"],
    [/最需要改进|需要改善|自身.*不足/, "skills", "improvementAreas"],
    [/学校.*组织活动.*经验|校园活动.*收获/, "skills", "campusActivitySummary"],
  ].filter(([pattern, section]) => pattern.test(text) && !(field.questionContext && section !== "customAnswers"));
  if (matches.length === 1) return { section: matches[0][1], property: matches[0][2] };
  return { section: "customAnswers", question: [field.questionContext, field.label].filter(Boolean).join(" / ").slice(0, 180) };
}
