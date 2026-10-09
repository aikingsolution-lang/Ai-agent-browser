import { useState, useEffect, useRef, useCallback } from 'react';
import {
  type ICareerBrain,
  type IWorkExperienceItem,
  type IGoldenAnswer,
  type IResumeProfileItem,
  extractResumeFocusTags,
  DEFAULT_GOLDEN_ANSWERS,
  getCareerBrainData,
  saveCareerBrainData,
  DEFAULT_CAREER_BRAIN,
  careerBrainStore,
  authStorage,
  isGenericWorkExperienceDateField,
  cleanLocationForCityField,
  isNarrativeAnswerableQuestion,
  sanitizeRoleSearchQuery,
} from '@extension/storage';
import {
  backendApiClient,
  isValidSkillName,
  cleanSkillName,
  validateAndSanitizeSkillExperience,
} from '@extension/shared';
import {
  FiUploadCloud,
  FiCheckCircle,
  FiAlertCircle,
  FiAlertTriangle,
  FiUser,
  FiBriefcase,
  FiMail,
  FiPhone,
  FiMapPin,
  FiAward,
  FiClock,
  FiEdit2,
  FiSave,
  FiDollarSign,
  FiBookOpen,
  FiTrash2,
  FiPlus,
  FiCheck,
  FiX,
  FiCalendar,
  FiLock,
  FiFileText,
  FiExternalLink,
} from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { SkillAutocompleteInput } from './SkillAutocompleteInput';
import { JobTitleAutocompleteInput } from './JobTitleAutocompleteInput';
import { MultipleJobRolesInput } from './MultipleJobRolesInput';
import { LocationAutocompleteInput } from './LocationAutocompleteInput';
import { PrioritizedLocationsInput } from './PrioritizedLocationsInput';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface ResumeProfileViewProps {
  isDarkMode?: boolean;
}

export function ResumeProfileView({ isDarkMode = false }: ResumeProfileViewProps) {
  const [profile, setProfile] = useState<ICareerBrain>(DEFAULT_CAREER_BRAIN);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: 'success' | 'warning' | 'error' | 'info';
    message: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<ICareerBrain>(DEFAULT_CAREER_BRAIN);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasAuth, setHasAuth] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    const checkAuth = async () => {
      const session = await authStorage.getSession();
      if (mounted) setHasAuth(Boolean(session?.token));
    };
    checkAuth();
    const unsub = authStorage.subscribe(() => {
      checkAuth();
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // Skill experience & Golden Answers state
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillYears, setNewSkillYears] = useState<number | ''>('');
  const [newPrimarySkill, setNewPrimarySkill] = useState('');
  const [editingGoldenId, setEditingGoldenId] = useState<string | null>(null);
  const [editingGoldenAnswer, setEditingGoldenAnswer] = useState('');
  const [newQuestionText, setNewQuestionText] = useState('');
  const [newAnswerText, setNewAnswerText] = useState('');
  const [showAddGolden, setShowAddGolden] = useState(false);

  // Work experience state
  const [showWorkExpForm, setShowWorkExpForm] = useState(false);
  const [editingWorkExpId, setEditingWorkExpId] = useState<string | null>(null);
  const [workExpCompany, setWorkExpCompany] = useState('');
  const [workExpTitle, setWorkExpTitle] = useState('');
  const [workExpStartMonth, setWorkExpStartMonth] = useState('');
  const [workExpStartYear, setWorkExpStartYear] = useState('');
  const [workExpEndMonth, setWorkExpEndMonth] = useState('');
  const [workExpEndYear, setWorkExpEndYear] = useState('');
  const [workExpIsCurrent, setWorkExpIsCurrent] = useState(false);
  const [workExpDescription, setWorkExpDescription] = useState('');

  const resetWorkExpForm = () => {
    setShowWorkExpForm(false);
    setEditingWorkExpId(null);
    setWorkExpCompany('');
    setWorkExpTitle('');
    setWorkExpStartMonth('');
    setWorkExpStartYear('');
    setWorkExpEndMonth('');
    setWorkExpEndYear('');
    setWorkExpIsCurrent(false);
    setWorkExpDescription('');
  };

  const startEditWorkExp = (item: IWorkExperienceItem) => {
    setEditingWorkExpId(item.id);
    setWorkExpCompany(item.company);
    setWorkExpTitle(item.title);
    setWorkExpStartMonth(item.startMonth || '');
    setWorkExpStartYear(item.startYear || '');
    setWorkExpEndMonth(item.endMonth || '');
    setWorkExpEndYear(item.endYear || '');
    setWorkExpIsCurrent(Boolean(item.isCurrent));
    setWorkExpDescription(item.description || '');
    setShowWorkExpForm(true);
  };

  const handleSaveWorkExp = async () => {
    if (!workExpCompany.trim() || !workExpTitle.trim()) return;

    await careerBrainStore.saveWorkExperienceItem({
      id: editingWorkExpId || undefined,
      company: workExpCompany.trim(),
      title: workExpTitle.trim(),
      startMonth: workExpStartMonth.trim(),
      startYear: workExpStartYear.trim(),
      endMonth: workExpIsCurrent ? null : workExpEndMonth.trim() || null,
      endYear: workExpIsCurrent ? null : workExpEndYear.trim() || null,
      isCurrent: workExpIsCurrent,
      description: workExpDescription.trim(),
      source: editingWorkExpId
        ? profile.workExperience?.find(w => w.id === editingWorkExpId)?.source || 'manual'
        : 'manual',
    });

    const updated = await careerBrainStore.getCareerBrain();
    setProfile(updated);
    resetWorkExpForm();
  };

  const handleDeleteWorkExp = async (id: string) => {
    await careerBrainStore.deleteWorkExperienceItem(id);
    const updated = await careerBrainStore.getCareerBrain();
    setProfile(updated);
  };

  const formatDateRange = (item: IWorkExperienceItem) => {
    const start = [item.startMonth, item.startYear].filter(Boolean).join(' ');
    if (item.isCurrent) {
      return start ? `${start} – Present` : 'Present';
    }
    const end = [item.endMonth, item.endYear].filter(Boolean).join(' ');
    if (!start && !end) return '';
    if (start && end) return `${start} – ${end}`;
    return start || end;
  };

  // Load existing Career Brain data on mount and sanitize garbage skills
  useEffect(() => {
    getCareerBrainData().then(data => {
      if (data) {
        let modified = false;
        if (data.skillExperience) {
          const sanitized = validateAndSanitizeSkillExperience(
            data.skillExperience,
            data.workExperience,
            data.resumeText,
            data.yearsOfExperience,
          );
          if (
            Object.keys(sanitized).length !== Object.keys(data.skillExperience).length ||
            Object.entries(sanitized).some(([k, v]) => data.skillExperience![k] !== v)
          ) {
            data.skillExperience = sanitized;
            modified = true;
          }
        }
        if (data.autoExtractedSkills && data.autoExtractedSkills.length > 0) {
          const cleanedAuto = data.autoExtractedSkills.map(cleanSkillName).filter(isValidSkillName);
          if (cleanedAuto.length !== data.autoExtractedSkills.length) {
            data.autoExtractedSkills = cleanedAuto;
            modified = true;
          }
        }
        if (data.skills && data.skills.length > 0) {
          const cleanedSkills = data.skills.map(cleanSkillName).filter(isValidSkillName);
          if (cleanedSkills.length !== data.skills.length) {
            data.skills = cleanedSkills;
            modified = true;
          }
          // Seed any missing skills from Primary Skills into skillExperience
          const candidateTenure = Math.max(1, Math.min(data.yearsOfExperience || 1, 99));
          const currentExp = { ...(data.skillExperience || {}) };
          let expChanged = false;
          for (const s of cleanedSkills) {
            if (!currentExp[s] || currentExp[s] <= 0) {
              currentExp[s] = candidateTenure;
              expChanged = true;
            }
          }
          if (expChanged) {
            data.skillExperience = currentExp;
            data.autoExtractedSkills = Array.from(new Set([...(data.autoExtractedSkills || []), ...cleanedSkills]));
            modified = true;
          }
        }
        if (data.goldenAnswers && data.goldenAnswers.length > 0) {
          const cleanedGolden = data.goldenAnswers.filter(ga => !isGenericWorkExperienceDateField(ga.question));
          if (cleanedGolden.length !== data.goldenAnswers.length) {
            data.goldenAnswers = cleanedGolden;
            modified = true;
          }
        }
        if (data.preferredLocation && /remote|hybrid/i.test(data.preferredLocation)) {
          const cleaned = cleanLocationForCityField(data.preferredLocation);
          if (cleaned && cleaned !== data.preferredLocation) {
            data.preferredLocation = cleaned;
            modified = true;
          }
        }
        if (data.currentLocation && /remote|hybrid/i.test(data.currentLocation)) {
          const cleaned = cleanLocationForCityField(data.currentLocation);
          if (cleaned && cleaned !== data.currentLocation) {
            data.currentLocation = cleaned;
            modified = true;
          }
        }
        if (modified) {
          saveCareerBrainData(data);
        }
        setProfile(data);
        setEditForm(data);
      }
    });

    // Real-time synchronization with Options Page and background storage
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes['linkedin_career_brain']?.newValue) {
        const newData = changes['linkedin_career_brain'].newValue as ICareerBrain;
        setProfile(newData);
        setEditForm(prev => (isEditing ? prev : newData));
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [isEditing]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!file) return;

      const validExtensions = ['.pdf', '.doc', '.docx'];
      const fileName = file.name.toLowerCase();
      const isValid = validExtensions.some(ext => fileName.endsWith(ext));

      if (!isValid) {
        setUploadStatus({
          type: 'error',
          message: 'Invalid file format. Please upload a PDF or Word (.doc, .docx) document.',
        });
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        setUploadStatus({
          type: 'error',
          message: 'File size exceeds 10MB limit.',
        });
        return;
      }

      setIsUploading(true);
      setUploadStatus({
        type: 'info',
        message: `Analyzing "${file.name}"...`,
      });

      let sessionToken: string | null = null;
      try {
        const session = await authStorage.getSession();
        sessionToken = session?.token || null;
        if (sessionToken) {
          backendApiClient.setToken(sessionToken);
        }

        // 1. Try backend parsing API
        const res = await backendApiClient.uploadAndParseResume(file, file.name);

        if (res.data?.parsedData) {
          const parsed = res.data.parsedData;
          const rawResumeText =
            res.data.rawText || (res.data as any).careerBrain?.resumeText || parsed.backgroundNarrative || '';

          // If backend did not extract skillExperience, screening fields, or workExperience, attempt extension-side LLM enrichment pass
          let extractedSkillExp: Record<string, number> = parsed.skillExperience || {};
          let extractedWorkAuth: string | undefined = parsed.workAuthorization;
          let extractedNotice: string | undefined = parsed.noticePeriod;
          let extractedCollege: string | undefined = parsed.college;
          let extractedEducation: string | undefined = parsed.education;
          let extractedYoe: number | undefined = parsed.yearsOfExperience;
          let extractedWorkExp: any[] = Array.isArray(parsed.workExperience) ? parsed.workExperience : [];
          let extractedNarrative: string | undefined = parsed.backgroundNarrative;
          let extractedGoldenAnswers: IGoldenAnswer[] | undefined = Array.isArray(parsed.goldenAnswers)
            ? parsed.goldenAnswers
            : undefined;

          const needsEnrichment =
            (!extractedNarrative ||
              extractedNarrative.length < 100 ||
              !extractedGoldenAnswers ||
              extractedGoldenAnswers.length === 0 ||
              Object.keys(extractedSkillExp).length === 0 ||
              extractedWorkExp.length === 0) &&
            Boolean(rawResumeText);

          if (needsEnrichment && rawResumeText) {
            try {
              const enrichRes = await new Promise<any>(resolve => {
                chrome.runtime.sendMessage(
                  { type: 'ENRICH_PROFILE_FROM_RESUME', resumeText: rawResumeText },
                  response => resolve(response),
                );
              });
              if (enrichRes?.success && enrichRes.data) {
                if (enrichRes.data.skillExperience && Object.keys(extractedSkillExp).length === 0) {
                  extractedSkillExp = enrichRes.data.skillExperience;
                }
                if (!extractedWorkAuth && enrichRes.data.workAuthorization) {
                  extractedWorkAuth = enrichRes.data.workAuthorization;
                }
                if (!extractedNotice && enrichRes.data.noticePeriod) {
                  extractedNotice = enrichRes.data.noticePeriod;
                }
                if (!extractedCollege && enrichRes.data.college) {
                  extractedCollege = enrichRes.data.college;
                }
                if (!extractedEducation && enrichRes.data.education) {
                  extractedEducation = enrichRes.data.education;
                }
                if ((!extractedYoe || extractedYoe === 0) && enrichRes.data.yearsOfExperience) {
                  extractedYoe = enrichRes.data.yearsOfExperience;
                }
                if (extractedWorkExp.length === 0 && Array.isArray(enrichRes.data.workExperience)) {
                  extractedWorkExp = enrichRes.data.workExperience;
                }
                if (enrichRes.data.backgroundNarrative && (!extractedNarrative || extractedNarrative.length < 100)) {
                  extractedNarrative = enrichRes.data.backgroundNarrative;
                }
                if (
                  Array.isArray(enrichRes.data.goldenAnswers) &&
                  enrichRes.data.goldenAnswers.length > 0 &&
                  (!extractedGoldenAnswers || extractedGoldenAnswers.length === 0)
                ) {
                  extractedGoldenAnswers = enrichRes.data.goldenAnswers;
                }
              }
            } catch (e) {
              console.warn('[ResumeProfileView] Background LLM enrichment pass error:', e);
            }
          }

          // 1. Sanitize extracted skills against verifiable tenure and explicit mentions
          extractedSkillExp = validateAndSanitizeSkillExperience(
            extractedSkillExp,
            extractedWorkExp,
            rawResumeText,
            extractedYoe,
          );

          // 1. Sanitize extracted skills against verifiable tenure and explicit mentions from the NEW resume
          extractedSkillExp = validateAndSanitizeSkillExperience(
            extractedSkillExp,
            extractedWorkExp,
            rawResumeText,
            extractedYoe,
          );

          // 2. Clean-slate skills for NEW resume: Completely remove old resume skills!
          const cleanSkillExp: Record<string, number> = {};
          const autoExtractedSkillNames: string[] = [];

          for (const [skill, yrs] of Object.entries(extractedSkillExp)) {
            if (!skill || yrs === undefined || isNaN(Number(yrs))) continue;
            const cleanSkill = cleanSkillName(skill);
            if (!isValidSkillName(cleanSkill)) continue;

            cleanSkillExp[cleanSkill] = Number(yrs);
            autoExtractedSkillNames.push(cleanSkill);
          }

          // 3. Clean-slate work experience for NEW resume: Completely remove old resume jobs!
          const cleanWorkExp: IWorkExperienceItem[] = extractedWorkExp
            .filter((item: any) => item && (item.company || item.title))
            .map((item: any) => ({
              id: item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              company: (item.company || '').trim(),
              title: (item.title || '').trim(),
              startMonth: (item.startMonth || '').trim(),
              startYear: (item.startYear || '').trim(),
              endMonth: item.isCurrent ? null : item.endMonth ? String(item.endMonth).trim() : null,
              endYear: item.isCurrent ? null : item.endYear ? String(item.endYear).trim() : null,
              isCurrent: Boolean(item.isCurrent),
              description: (item.description || '').trim(),
              source: 'resume' as const,
            }));

          const hasWorkExperience = cleanWorkExp.length > 0;

          // 4. Primary skills: Extracted exclusively from the new resume
          const validParsedSkills = Array.isArray(parsed.skills)
            ? parsed.skills.map(cleanSkillName).filter(isValidSkillName)
            : [];
          const finalSkills = Array.from(new Set([...validParsedSkills, ...autoExtractedSkillNames]));

          // Auto-seed ALL Primary Skills into cleanSkillExp with candidate verifiable tenure
          const candidateTenure = Math.max(1, Math.min(extractedYoe || profile.yearsOfExperience || 1, 99));
          for (const skill of finalSkills) {
            if (!cleanSkillExp[skill] || cleanSkillExp[skill] <= 0) {
              cleanSkillExp[skill] = candidateTenure;
            }
          }
          const allAutoExtractedSkills = Array.from(new Set([...autoExtractedSkillNames, ...finalSkills]));

          // 5. Candidate Background Narrative: Exclusively from new resume
          const finalBackgroundNarrative = extractedNarrative || parsed.backgroundNarrative || '';

          // 6. Golden Q&A Screening Bank: Freshly calibrated exclusively from new resume (excluding narrative questions)!
          let finalGoldenAnswers: IGoldenAnswer[] = [];
          if (extractedGoldenAnswers && extractedGoldenAnswers.length > 0) {
            finalGoldenAnswers = extractedGoldenAnswers
              .filter(g => !isNarrativeAnswerableQuestion(g.question, g.id))
              .map(g => ({
                id: g.id || `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                question: g.question.trim(),
                answer: g.answer.trim(),
                category: g.category || 'Eligibility / Legal',
                isDefault: Boolean(g.isDefault ?? true),
              }));
          } else {
            finalGoldenAnswers = [...DEFAULT_GOLDEN_ANSWERS];
          }

          const resolvedCandidateName = parsed.fullName?.trim() || profile.fullName || 'Candidate';
          const safeTitle = sanitizeRoleSearchQuery(
            parsed.currentTitle || profile.currentTitle,
            resolvedCandidateName,
            'Full Stack Developer',
          );

          const focusTags = extractResumeFocusTags(rawResumeText, finalSkills, safeTitle);
          const newResumeId = `res_${Date.now()}`;
          const currentResumes = Array.isArray(profile.resumes) ? [...profile.resumes] : [];
          const newResumeItem: IResumeProfileItem = {
            id: newResumeId,
            fileName: file.name,
            uploadedAt: Date.now(),
            focusTags,
            rawText: rawResumeText,
            extractedSkills: finalSkills,
            summary: finalBackgroundNarrative.slice(0, 300),
            targetRole: safeTitle,
            isDefault: currentResumes.length === 0,
          };

          const existingIdx = currentResumes.findIndex(r => r.fileName.toLowerCase() === file.name.toLowerCase());
          if (existingIdx >= 0) {
            currentResumes[existingIdx] = { ...newResumeItem, id: currentResumes[existingIdx].id };
          } else {
            currentResumes.push(newResumeItem);
          }

          // 7. Assemble clean profile: completely replacing old resume data
          const updated: ICareerBrain = {
            ...DEFAULT_CAREER_BRAIN,
            fullName: resolvedCandidateName,
            email: parsed.email?.trim() || profile.email || '',
            phoneNumber: parsed.phoneNumber?.trim() || '',
            currentTitle: safeTitle,
            skills: finalSkills,
            yearsOfExperience: extractedYoe !== undefined && extractedYoe >= 0 ? extractedYoe : 0,
            hasWorkExperience,
            workExperience: cleanWorkExp,
            education: extractedEducation || parsed.education || '',
            college: extractedCollege || parsed.college || '',
            cgpa: parsed.cgpa || '',
            currentCTC: parsed.currentCTC || '',
            expectedCTC: parsed.expectedCTC || '',
            currentLocation: cleanLocationForCityField(parsed.currentLocation) || parsed.currentLocation || '',
            noticePeriod: extractedNotice || parsed.noticePeriod || 'Immediate',
            backgroundNarrative: finalBackgroundNarrative,
            goldenAnswers: finalGoldenAnswers,
            preferredLocation: cleanLocationForCityField(parsed.preferredLocation) || parsed.preferredLocation || '',
            preferredLocations:
              Array.isArray(parsed.preferredLocations) && parsed.preferredLocations.length > 0
                ? parsed.preferredLocations.slice(0, 3)
                : cleanLocationForCityField(parsed.preferredLocation)
                  ? [cleanLocationForCityField(parsed.preferredLocation)]
                  : ['Bengaluru, Karnataka, India'],
            workAuthorization: extractedWorkAuth || parsed.workAuthorization || DEFAULT_CAREER_BRAIN.workAuthorization,
            resumeText: rawResumeText || '',
            resumeFileName: file.name,
            resumes: currentResumes,
            activeResumeId: currentResumes.find(r => r.isDefault)?.id || newResumeItem.id,
            skillExperience: cleanSkillExp,
            autoExtractedSkills: allAutoExtractedSkills,
            updatedAt: Date.now(),
          };

          await saveCareerBrainData(updated);
          setProfile(updated);
          setEditForm(updated);

          const addedDetails: string[] = [];
          if (finalSkills.length > 0) {
            addedDetails.push(`${finalSkills.length} skill(s)`);
          }
          if (cleanWorkExp.length > 0) {
            addedDetails.push(`${cleanWorkExp.length} work position(s)`);
          }
          if (finalBackgroundNarrative) {
            addedDetails.push('Candidate Narrative');
          }
          if (finalGoldenAnswers.length > 0) {
            addedDetails.push('Screening Answer Bank');
          }
          if (focusTags.length > 0) {
            addedDetails.push(`Tags: ${focusTags.join(', ')}`);
          }

          if (addedDetails.length > 0) {
            setUploadStatus({
              type: 'success',
              message: `✅ New resume "${file.name}" saved! Profile updated with: ${addedDetails.join(', ')}.`,
            });
          } else {
            setUploadStatus({
              type: 'warning',
              message: `⚠️ "${file.name}" saved, but limited details were extracted. Please check your fields below.`,
            });
          }
        } else {
          throw new Error(res.message || res.error?.code || 'Failed to extract resume data from server');
        }
      } catch (err: unknown) {
        console.warn('[ResumeProfileView] Backend parsing offline or error, saving local metadata:', err);

        // Local fallback: update file name and preserve profile with resume profile entry
        const localTags = extractResumeFocusTags(profile.resumeText || '', profile.skills || [], profile.currentTitle);
        const localResumes = Array.isArray(profile.resumes) ? [...profile.resumes] : [];
        const localResumeId = `res_${Date.now()}`;
        const localItem: IResumeProfileItem = {
          id: localResumeId,
          fileName: file.name,
          uploadedAt: Date.now(),
          focusTags: localTags,
          rawText: profile.resumeText || '',
          extractedSkills: profile.skills || [],
          isDefault: localResumes.length === 0,
        };
        const localIdx = localResumes.findIndex(r => r.fileName.toLowerCase() === file.name.toLowerCase());
        if (localIdx >= 0) {
          localResumes[localIdx] = { ...localItem, id: localResumes[localIdx].id };
        } else {
          localResumes.push(localItem);
        }

        const localUpdated: ICareerBrain = {
          ...profile,
          resumeFileName: file.name,
          resumes: localResumes,
          activeResumeId: localResumes.find(r => r.isDefault)?.id || localResumeId,
          updatedAt: Date.now(),
        };
        await saveCareerBrainData(localUpdated);
        setProfile(localUpdated);
        setEditForm(localUpdated);

        // Extract specific human-readable reason
        let reason = 'Service unavailable';
        const anyErr = err as any;
        if (
          !sessionToken ||
          anyErr?.status === 401 ||
          anyErr?.code === 'UNAUTHORIZED' ||
          anyErr?.message?.toLowerCase().includes('auth') ||
          anyErr?.message?.toLowerCase().includes('401')
        ) {
          reason = 'Authentication required (you are not signed in or session expired)';
        } else if (
          anyErr?.message?.toLowerCase().includes('fetch') ||
          anyErr?.message?.toLowerCase().includes('network')
        ) {
          reason = 'Backend server is unreachable';
        } else if (anyErr?.message) {
          reason = anyErr.message;
        }

        setUploadStatus({
          type: 'warning',
          message: `⚠️ Resume saved, but automatic skill detection failed: ${reason}. Please sign in and try again, or add skills manually.`,
        });
      } finally {
        setIsUploading(false);
      }
    },
    [profile],
  );

  const handleSetActiveResume = async (id: string) => {
    await careerBrainStore.setActiveResumeId(id);
    const updated = await careerBrainStore.getCareerBrain();
    setProfile(updated);
    setEditForm(updated);
    setUploadStatus({
      type: 'info',
      message: `Active default resume switched to "${updated.resumeFileName}".`,
    });
  };

  const handleDeleteResume = async (id: string) => {
    await careerBrainStore.deleteResumeProfile(id);
    const updated = await careerBrainStore.getCareerBrain();
    setProfile(updated);
    setEditForm(updated);
    setUploadStatus({
      type: 'info',
      message: 'Resume profile removed.',
    });
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      const current = await getCareerBrainData();
      const updated: ICareerBrain = {
        ...current,
        ...editForm,
        expectedCTC: editForm.expectedCTC || editForm.salaryExpectation || '',
        salaryExpectation: editForm.salaryExpectation || editForm.expectedCTC || '',
        updatedAt: Date.now(),
      };
      await saveCareerBrainData(updated);
      setProfile(updated);
      setIsEditing(false);
      setUploadStatus({
        type: 'success',
        message: '✅ Candidate details saved successfully!',
      });
    } catch (e) {
      setUploadStatus({
        type: 'error',
        message: 'Failed to save profile changes.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  if (!hasAuth) {
    return (
      <div
        className={`flex flex-1 flex-col items-center justify-center p-8 text-center min-h-[350px] ${
          isDarkMode ? 'text-gray-300' : 'text-gray-600'
        }`}>
        <FiLock className="size-12 text-sky-400 mb-3" />
        <h3 className="text-base font-bold mb-1">Authentication Required</h3>
        <p className="text-xs text-gray-400 max-w-xs">
          Please sign in to upload resumes, build your Career Brain, and configure application details.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-1 flex-col overflow-y-auto p-4 space-y-4 ${isDarkMode ? 'text-gray-100' : 'text-gray-800'}`}>
      {/* Upload Box */}
      <div
        onDragOver={e => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl cursor-pointer transition-all ${
          isDragging
            ? 'border-sky-500 bg-sky-50/20'
            : isDarkMode
              ? 'border-sky-800/80 bg-slate-800/50 hover:border-sky-600 hover:bg-slate-800'
              : 'border-sky-300 bg-sky-50/50 hover:border-sky-500 hover:bg-sky-50'
        }`}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx"
          className="hidden"
          onChange={e => {
            if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
          }}
        />

        {isUploading ? (
          <div className="flex flex-col items-center space-y-2">
            <AiOutlineLoading3Quarters className="size-8 animate-spin text-sky-500" />
            <p className="text-xs font-semibold text-sky-500">Processing Resume...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center space-y-2 text-center">
            <div className="rounded-full bg-sky-500/10 p-3 text-sky-500">
              <FiUploadCloud className="size-6" />
            </div>
            <div>
              <p className="text-xs font-bold">
                {profile.resumes && profile.resumes.length > 0
                  ? 'Upload Another Resume (e.g. Frontend vs Backend)'
                  : 'Upload Resume (PDF / Word)'}
              </p>
              <p className="text-[11px] opacity-70">Drag & drop or click to browse (Max 10MB)</p>
            </div>
            {profile.resumeFileName && (
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                Active: {profile.resumeFileName}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Upload Notification Alert */}
      {uploadStatus && (
        <div
          className={`flex items-start space-x-2 rounded-lg p-3 text-xs font-medium leading-relaxed ${
            uploadStatus.type === 'success'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : uploadStatus.type === 'warning'
                ? 'border border-amber-500/40 bg-amber-500/10 text-amber-300'
                : uploadStatus.type === 'error'
                  ? 'border border-red-500/30 bg-red-500/10 text-red-400'
                  : 'border border-sky-500/30 bg-sky-500/10 text-sky-400'
          }`}>
          {uploadStatus.type === 'success' ? (
            <FiCheckCircle className="size-4 shrink-0 text-emerald-400 mt-0.5" />
          ) : uploadStatus.type === 'warning' ? (
            <FiAlertTriangle className="size-4 shrink-0 text-amber-400 mt-0.5" />
          ) : uploadStatus.type === 'error' ? (
            <FiAlertCircle className="size-4 shrink-0 text-red-400 mt-0.5" />
          ) : (
            <AiOutlineLoading3Quarters className="size-4 shrink-0 animate-spin text-sky-400 mt-0.5" />
          )}
          <span className="flex-1">{uploadStatus.message}</span>
        </div>
      )}

      {/* Resume Profiles & Smart Best Match Auto-Select */}
      {profile.resumes && profile.resumes.length > 0 && (
        <div
          className={`rounded-xl border p-4 space-y-3 ${
            isDarkMode ? 'border-sky-900 bg-slate-800/80' : 'border-sky-100 bg-white/90 shadow-sm'
          }`}>
          <div className="flex items-center justify-between border-b pb-2 border-gray-200/20">
            <div className="flex items-center space-x-2">
              <FiFileText className="size-4 text-sky-500" />
              <h3 className="text-sm font-bold">Resume Profiles ({profile.resumes.length})</h3>
            </div>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
              ⚡ Best Match Auto-Select
            </span>
          </div>
          <p className="text-[11px] opacity-70 leading-relaxed">
            NanoBrowser dynamically analyzes job descriptions and auto-selects the resume profile with the highest skill
            & keyword match for each application.
          </p>

          <div className="space-y-2">
            {profile.resumes.map(r => {
              const isActive = r.id === profile.activeResumeId || r.isDefault;
              return (
                <div
                  key={r.id}
                  className={`flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 rounded-lg border text-xs transition-colors ${
                    isActive
                      ? isDarkMode
                        ? 'border-emerald-500/40 bg-emerald-950/20'
                        : 'border-emerald-300 bg-emerald-50/50'
                      : isDarkMode
                        ? 'border-gray-800 bg-slate-900/40 hover:border-gray-700'
                        : 'border-gray-200 bg-gray-50/50 hover:border-gray-300'
                  }`}>
                  <div className="space-y-1.5 flex-1 pr-2">
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold truncate max-w-[220px]" title={r.fileName}>
                        {r.fileName}
                      </span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">
                          <FiCheck className="size-3" /> Default
                        </span>
                      )}
                    </div>
                    {r.focusTags && r.focusTags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {r.focusTags.map(tag => (
                          <span
                            key={tag}
                            className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                              isDarkMode
                                ? 'bg-sky-900/40 text-sky-300 border border-sky-800/40'
                                : 'bg-sky-50 text-sky-700 border border-sky-200'
                            }`}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center space-x-2 mt-2 sm:mt-0 shrink-0">
                    {!isActive && (
                      <button
                        onClick={() => handleSetActiveResume(r.id)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          isDarkMode
                            ? 'bg-slate-700 hover:bg-slate-600 text-gray-200'
                            : 'bg-white hover:bg-gray-100 text-gray-700 border border-gray-200 shadow-sm'
                        }`}>
                        Set Default
                      </button>
                    )}
                    {profile.resumes.length > 1 && (
                      <button
                        onClick={() => handleDeleteResume(r.id)}
                        className="p-1.5 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Delete resume profile">
                        <FiTrash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Candidate Profile Details Card */}
      <div
        className={`rounded-xl border p-4 space-y-3 ${isDarkMode ? 'border-sky-900 bg-slate-800/80' : 'border-sky-100 bg-white/90 shadow-sm'}`}>
        <div className="flex items-center justify-between border-b pb-2 border-gray-200/20">
          <div className="flex items-center space-x-2">
            <FiUser className="size-4 text-sky-500" />
            <h3 className="text-sm font-bold">{profile.fullName || 'Candidate Profile'}</h3>
          </div>
          <button
            onClick={() => {
              if (isEditing) {
                handleSaveProfile();
              } else {
                setEditForm(profile);
                setIsEditing(true);
              }
            }}
            disabled={isSaving}
            className={`flex items-center space-x-1 rounded-md px-2.5 py-1 text-xs font-semibold cursor-pointer transition-colors ${
              isEditing
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-400'
            }`}>
            {isEditing ? (
              <>
                <FiSave className="size-3" />
                <span>Save</span>
              </>
            ) : (
              <>
                <FiEdit2 className="size-3" />
                <span>Edit</span>
              </>
            )}
          </button>
        </div>

        {isEditing ? (
          /* Editable Form */
          <div className="space-y-2.5 text-xs">
            <div>
              <label className="block text-[11px] font-semibold opacity-70 mb-1">Full Name</label>
              <input
                type="text"
                value={editForm.fullName}
                onChange={e => setEditForm(prev => ({ ...prev, fullName: e.target.value }))}
                className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                  isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                }`}
                placeholder="e.g. Rahul Sharma"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Gender</label>
                <select
                  value={editForm.gender || 'Male'}
                  onChange={e => setEditForm(prev => ({ ...prev, gender: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                  <option value="Prefer not to say">Prefer not to say</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Years of Exp</label>
                <input
                  type="number"
                  value={editForm.yearsOfExperience}
                  onChange={e => setEditForm(prev => ({ ...prev, yearsOfExperience: Number(e.target.value) || 0 }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="3"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={editForm.phoneNumber}
                  onChange={e => setEditForm(prev => ({ ...prev, phoneNumber: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="+91 9876543210"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={e => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="rahul@example.com"
                />
              </div>
            </div>
            <div>
              <MultipleJobRolesInput
                roles={
                  Array.isArray(editForm.predefinedRoles) && editForm.predefinedRoles.length > 0
                    ? editForm.predefinedRoles
                    : editForm.currentTitle
                      ? [editForm.currentTitle]
                      : []
                }
                primaryRole={editForm.currentTitle}
                onChange={(roles, primary) => {
                  setEditForm(prev => ({
                    ...prev,
                    predefinedRoles: roles,
                    currentTitle: primary || roles[0] || '',
                  }));
                }}
                isDarkMode={isDarkMode}
                careerBrain={editForm}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">College / University</label>
                <input
                  type="text"
                  value={editForm.college || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, college: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="e.g. Maulana Abul Kalam Azad Univ"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">CGPA / Percentage</label>
                <input
                  type="text"
                  value={editForm.cgpa || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, cgpa: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="e.g. 8.57 / 10"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Current CTC</label>
                <input
                  type="text"
                  value={editForm.currentCTC || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, currentCTC: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="e.g. ₹6,00,000"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Expected CTC</label>
                <input
                  type="text"
                  value={editForm.expectedCTC || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, expectedCTC: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="e.g. ₹10,00,000"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">
                  Current Location <span className="text-[9px] text-sky-400 font-normal">(City, State, Country)</span>
                </label>
                <LocationAutocompleteInput
                  value={editForm.currentLocation || ''}
                  onChange={val => setEditForm(prev => ({ ...prev, currentLocation: val }))}
                  isDarkMode={isDarkMode}
                  isPreferred={false}
                  placeholder="e.g. Bengaluru, Karnataka, India"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold opacity-70 mb-1">Notice Period</label>
                <input
                  type="text"
                  value={editForm.noticePeriod || ''}
                  onChange={e => setEditForm(prev => ({ ...prev, noticePeriod: e.target.value }))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  placeholder="e.g. Immediate / 15 Days"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] font-semibold opacity-70">
                  Target Preferred Locations{' '}
                  <span className="text-[9px] text-sky-400 font-normal">(Top 3 Prioritized)</span>
                </label>
                <span className="text-[9px] text-gray-400">#1 gets highest priority</span>
              </div>
              <PrioritizedLocationsInput
                locations={
                  editForm.preferredLocations && editForm.preferredLocations.length > 0
                    ? editForm.preferredLocations
                    : [editForm.preferredLocation || '']
                }
                onChange={locs => {
                  setEditForm(prev => ({
                    ...prev,
                    preferredLocations: locs,
                    preferredLocation: locs[0] || '',
                  }));
                }}
                isDarkMode={isDarkMode}
                maxLocations={3}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold opacity-70 mb-1">
                Primary Skills (Core Tech Stack)
              </label>
              {editForm.skills && editForm.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {editForm.skills.map((skill, idx) => (
                    <span
                      key={skill + idx}
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        isDarkMode
                          ? 'bg-sky-950 text-sky-300 border border-sky-800'
                          : 'bg-sky-50 text-sky-700 border border-sky-200'
                      }`}>
                      {skill}
                      <button
                        type="button"
                        onClick={() => {
                          setEditForm(prev => ({
                            ...prev,
                            skills: (prev.skills || []).filter((_, i) => i !== idx),
                          }));
                        }}
                        className="ml-1 text-gray-400 hover:text-red-400 focus:outline-none cursor-pointer">
                        <FiX className="size-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center space-x-2">
                <SkillAutocompleteInput
                  value={newPrimarySkill}
                  onChange={setNewPrimarySkill}
                  onSelect={skill => {
                    const trimmed = skill.trim();
                    if (trimmed && !(editForm.skills || []).some(s => s.toLowerCase() === trimmed.toLowerCase())) {
                      setEditForm(prev => ({ ...prev, skills: [...(prev.skills || []), trimmed] }));
                      setNewPrimarySkill('');
                    }
                  }}
                  isDarkMode={isDarkMode}
                  placeholder="e.g. React, Python, Docker..."
                  className={`w-full rounded-lg border px-3 py-1.5 text-xs outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const trimmed = newPrimarySkill.trim();
                      if (trimmed && !(editForm.skills || []).some(s => s.toLowerCase() === trimmed.toLowerCase())) {
                        setEditForm(prev => ({ ...prev, skills: [...(prev.skills || []), trimmed] }));
                        setNewPrimarySkill('');
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = newPrimarySkill.trim();
                    if (trimmed && !(editForm.skills || []).some(s => s.toLowerCase() === trimmed.toLowerCase())) {
                      setEditForm(prev => ({ ...prev, skills: [...(prev.skills || []), trimmed] }));
                      setNewPrimarySkill('');
                    }
                  }}
                  disabled={!newPrimarySkill.trim()}
                  className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-sky-400 disabled:opacity-50 cursor-pointer shrink-0">
                  Add
                </button>
              </div>
            </div>
            <div className="flex space-x-2 pt-2">
              <button
                onClick={handleSaveProfile}
                disabled={isSaving}
                className="flex-1 rounded-lg bg-sky-500 py-1.5 font-bold text-white hover:bg-sky-400 cursor-pointer">
                {isSaving ? 'Saving...' : 'Save Profile'}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className={`rounded-lg px-3 py-1.5 font-semibold cursor-pointer ${
                  isDarkMode ? 'bg-slate-700 hover:bg-slate-600' : 'bg-gray-200 hover:bg-gray-300'
                }`}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          /* View Mode */
          <div className="grid grid-cols-1 gap-2 text-xs opacity-90">
            <div className="flex items-start space-x-2">
              <FiBriefcase className="size-3.5 shrink-0 text-sky-400 mt-0.5" />
              <div className="min-w-0 flex-1">
                {Array.isArray(profile.predefinedRoles) && profile.predefinedRoles.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {profile.predefinedRoles.map((r, idx) => {
                      const isPrimary = r === (profile.currentTitle || profile.predefinedRoles![0]);
                      return (
                        <span
                          key={idx}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border ${
                            isPrimary
                              ? isDarkMode
                                ? 'bg-emerald-950/40 text-emerald-300 border-emerald-600/40 font-semibold'
                                : 'bg-emerald-50 text-emerald-800 border-emerald-300 font-semibold'
                              : isDarkMode
                                ? 'bg-slate-900 text-sky-300 border-sky-800'
                                : 'bg-sky-50 text-sky-700 border-sky-200'
                          }`}>
                          {isPrimary && <span>⭐</span>}
                          <span>{r}</span>
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <span className="font-semibold">{profile.currentTitle || 'Full Stack Developer'}</span>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <FiUser className="size-3.5 shrink-0 text-sky-400" />
              <span>
                Gender: <strong>{profile.gender || 'Male'}</strong> ({profile.yearsOfExperience ?? 0} yrs exp)
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <FiMail className="size-3.5 shrink-0 text-sky-400" />
              <span>{profile.email}</span>
            </div>
            <div className="flex items-center space-x-2">
              <FiPhone className="size-3.5 shrink-0 text-sky-400" />
              <span>{profile.phoneNumber}</span>
            </div>
            {profile.college && (
              <div className="flex items-center space-x-2">
                <FiBookOpen className="size-3.5 shrink-0 text-sky-400" />
                <span>
                  {profile.college}
                  {profile.cgpa ? ` (${profile.cgpa})` : ''}
                </span>
              </div>
            )}
            {(profile.currentCTC || profile.expectedCTC) && (
              <div className="flex items-center space-x-2">
                <FiDollarSign className="size-3.5 shrink-0 text-sky-400" />
                <span>
                  {profile.currentCTC ? `CTC: ${profile.currentCTC}` : ''}
                  {profile.currentCTC && profile.expectedCTC ? ' | ' : ''}
                  {profile.expectedCTC ? `Exp: ${profile.expectedCTC}` : ''}
                </span>
              </div>
            )}
            <div className="flex items-start space-x-2">
              <FiMapPin className="size-3.5 shrink-0 text-sky-400 mt-0.5" />
              <div className="min-w-0 flex-1 text-xs">
                <div>
                  <span className="opacity-70">Current: </span>
                  <strong className="font-semibold">{profile.currentLocation || 'Not specified'}</strong>
                </div>
                {profile.preferredLocations && profile.preferredLocations.length > 0 ? (
                  <div className="mt-1 space-y-0.5">
                    <span className="text-[10px] font-semibold text-sky-400">Target Locations (by Priority):</span>
                    {profile.preferredLocations.slice(0, 3).map((loc, i) => (
                      <div key={i} className="flex items-center gap-1.5 pl-0.5 text-[11px]">
                        <span
                          className={`text-[9px] font-bold px-1 rounded border ${
                            i === 0
                              ? 'text-emerald-300 bg-emerald-950/60 border-emerald-800'
                              : i === 1
                                ? 'text-sky-300 bg-sky-950/60 border-sky-800'
                                : 'text-purple-300 bg-purple-950/60 border-purple-800'
                          }`}>
                          #{i + 1}
                        </span>
                        <span className="truncate">{loc}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  profile.preferredLocation && (
                    <div className="text-[11px] text-gray-400 mt-0.5">Pref: {profile.preferredLocation}</div>
                  )
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <FiClock className="size-3.5 shrink-0 text-sky-400" />
              <span>
                Notice: <strong>{profile.noticePeriod || 'Immediate'}</strong>
              </span>
            </div>
            {profile.skills && profile.skills.length > 0 && (
              <div className="pt-2 border-t border-gray-200/20">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                  Primary Skills
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {profile.skills.map((s, idx) => (
                    <span
                      key={s + idx}
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        isDarkMode
                          ? 'bg-slate-800 text-sky-300 border border-slate-700'
                          : 'bg-sky-50 text-sky-700 border border-sky-100'
                      }`}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Work Experience Section */}
        <div className="pt-3 border-t border-gray-200/20 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-1.5">
              <FiBriefcase className="size-3.5 text-sky-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400">Work Experience</span>
            </div>
            {profile.hasWorkExperience !== false && (
              <button
                type="button"
                onClick={() => {
                  if (showWorkExpForm) {
                    resetWorkExpForm();
                  } else {
                    resetWorkExpForm();
                    setShowWorkExpForm(true);
                  }
                }}
                className="flex items-center space-x-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300 cursor-pointer">
                <FiPlus className="size-3" />
                <span>Add Position</span>
              </button>
            )}
          </div>

          {/* Do you have work experience? Yes / No Toggle */}
          <div
            className={`flex items-center justify-between p-2 rounded-lg border text-xs ${
              isDarkMode ? 'border-sky-900 bg-slate-900/60' : 'border-sky-100 bg-white/70'
            }`}>
            <span className="font-medium">Do you have work experience?</span>
            <div
              className={`flex rounded-md p-0.5 border ${
                isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-sky-200 bg-sky-50'
              }`}>
              <button
                type="button"
                onClick={async () => {
                  await careerBrainStore.setHasWorkExperience(true);
                  const updated = await careerBrainStore.getCareerBrain();
                  setProfile(updated);
                }}
                className={`px-3 py-0.5 rounded text-xs font-bold transition-all cursor-pointer ${
                  profile.hasWorkExperience !== false
                    ? 'bg-sky-500 text-white shadow-xs'
                    : 'text-gray-400 hover:text-gray-200'
                }`}>
                Yes
              </button>
              <button
                type="button"
                onClick={async () => {
                  await careerBrainStore.setHasWorkExperience(false);
                  const updated = await careerBrainStore.getCareerBrain();
                  setProfile(updated);
                  resetWorkExpForm();
                }}
                className={`px-3 py-0.5 rounded text-xs font-bold transition-all cursor-pointer ${
                  profile.hasWorkExperience === false
                    ? 'bg-sky-500 text-white shadow-xs'
                    : 'text-gray-400 hover:text-gray-200'
                }`}>
                No
              </button>
            </div>
          </div>

          {/* If No: Candidate is a fresher */}
          {profile.hasWorkExperience === false && (
            <div
              className={`p-2.5 rounded-lg border text-xs text-center ${
                isDarkMode
                  ? 'border-slate-800 bg-slate-900/40 text-gray-400'
                  : 'border-gray-200 bg-gray-50 text-gray-500'
              }`}>
              <p className="font-medium">Candidate is a fresher / entry level with no formal work experience.</p>
              <p className="text-[10px] opacity-75 mt-0.5">
                Work experience questions will be answered according to fresher status.
              </p>
            </div>
          )}

          {/* If Yes: Show List and Form */}
          {profile.hasWorkExperience !== false && (
            <>
              {/* Add / Edit Position Form */}
              {showWorkExpForm && (
                <div
                  className={`p-3 rounded-lg border space-y-2.5 text-xs ${
                    isDarkMode ? 'border-sky-900 bg-slate-900/80' : 'border-sky-100 bg-sky-50/50'
                  }`}>
                  <div className="flex items-center justify-between font-bold text-sky-400 text-[11px] uppercase tracking-wider">
                    <span>{editingWorkExpId ? 'Edit Position' : 'Add Position'}</span>
                    <button
                      type="button"
                      onClick={resetWorkExpForm}
                      className="text-gray-400 hover:text-gray-200 cursor-pointer">
                      <FiX className="size-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Company *</label>
                      <input
                        type="text"
                        placeholder="e.g. Google, Infosys"
                        value={workExpCompany}
                        onChange={e => setWorkExpCompany(e.target.value)}
                        className={`w-full rounded-lg border px-2.5 py-1 text-xs outline-none ${
                          isDarkMode
                            ? 'border-sky-900 bg-slate-800 text-white focus:border-sky-500'
                            : 'border-sky-200 bg-white text-gray-900 focus:border-sky-400'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Job Title *</label>
                      <JobTitleAutocompleteInput
                        placeholder="e.g. Software Engineer"
                        value={workExpTitle}
                        onChange={val => setWorkExpTitle(val)}
                        isDarkMode={isDarkMode}
                        className={`w-full rounded-lg border px-2.5 py-1 text-xs outline-none ${
                          isDarkMode
                            ? 'border-sky-900 bg-slate-800 text-white focus:border-sky-500'
                            : 'border-sky-200 bg-white text-gray-900 focus:border-sky-400'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Start Date */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Start Date</label>
                      <div className="flex space-x-1.5">
                        <select
                          value={workExpStartMonth}
                          onChange={e => setWorkExpStartMonth(e.target.value)}
                          className={`w-1/2 rounded-lg border px-1.5 py-1 text-xs outline-none ${
                            isDarkMode
                              ? 'border-sky-900 bg-slate-800 text-white'
                              : 'border-sky-200 bg-white text-gray-900'
                          }`}>
                          <option value="">Month</option>
                          {MONTHS.map(m => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="Year (2022)"
                          value={workExpStartYear}
                          onChange={e => setWorkExpStartYear(e.target.value)}
                          className={`w-1/2 rounded-lg border px-2 py-1 text-xs outline-none ${
                            isDarkMode
                              ? 'border-sky-900 bg-slate-800 text-white'
                              : 'border-sky-200 bg-white text-gray-900'
                          }`}
                        />
                      </div>
                    </div>

                    {/* End Date / Present */}
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <label className="text-[10px] font-semibold text-gray-400">End Date</label>
                        <label className="flex items-center space-x-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={workExpIsCurrent}
                            onChange={e => setWorkExpIsCurrent(e.target.checked)}
                            className="rounded border-slate-700 text-sky-500 focus:ring-0 size-3"
                          />
                          <span className="text-[10px] text-sky-400 font-medium">Currently work here</span>
                        </label>
                      </div>
                      {!workExpIsCurrent ? (
                        <div className="flex space-x-1.5">
                          <select
                            value={workExpEndMonth}
                            onChange={e => setWorkExpEndMonth(e.target.value)}
                            className={`w-1/2 rounded-lg border px-1.5 py-1 text-xs outline-none ${
                              isDarkMode
                                ? 'border-sky-900 bg-slate-800 text-white'
                                : 'border-sky-200 bg-white text-gray-900'
                            }`}>
                            <option value="">Month</option>
                            {MONTHS.map(m => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            placeholder="Year (2024)"
                            value={workExpEndYear}
                            onChange={e => setWorkExpEndYear(e.target.value)}
                            className={`w-1/2 rounded-lg border px-2 py-1 text-xs outline-none ${
                              isDarkMode
                                ? 'border-sky-900 bg-slate-800 text-white'
                                : 'border-sky-200 bg-white text-gray-900'
                            }`}
                          />
                        </div>
                      ) : (
                        <div
                          className={`rounded-lg border px-2 py-1 text-xs text-center font-semibold text-emerald-400 ${
                            isDarkMode ? 'border-emerald-900/50 bg-emerald-950/20' : 'border-emerald-200 bg-emerald-50'
                          }`}>
                          Present
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">
                      Description / Achievements
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Key responsibilities, technologies used, and accomplishments..."
                      value={workExpDescription}
                      onChange={e => setWorkExpDescription(e.target.value)}
                      className={`w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none resize-none ${
                        isDarkMode
                          ? 'border-sky-900 bg-slate-800 text-white focus:border-sky-500'
                          : 'border-sky-200 bg-white text-gray-900 focus:border-sky-400'
                      }`}
                    />
                  </div>

                  <div className="flex justify-end space-x-2 pt-1">
                    <button
                      type="button"
                      onClick={resetWorkExpForm}
                      className="px-2.5 py-1 text-xs font-medium text-gray-400 hover:text-gray-200 cursor-pointer">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveWorkExp}
                      disabled={!workExpCompany.trim() || !workExpTitle.trim()}
                      className="flex items-center space-x-1 rounded-lg bg-sky-500 px-3 py-1 text-xs font-bold text-white hover:bg-sky-400 disabled:opacity-50 cursor-pointer">
                      <FiCheck className="size-3" />
                      <span>{editingWorkExpId ? 'Update Position' : 'Save Position'}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Positions List */}
              {profile.workExperience && profile.workExperience.length > 0 ? (
                <div className="space-y-2">
                  {profile.workExperience.map(item => {
                    const dateRange = formatDateRange(item);
                    return (
                      <div
                        key={item.id}
                        className={`p-2.5 rounded-lg border text-xs transition-colors ${
                          isDarkMode ? 'border-sky-900/70 bg-slate-900/60' : 'border-sky-100 bg-white/70'
                        }`}>
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 pr-2">
                            <div className="flex items-center flex-wrap gap-1.5 mb-0.5">
                              <span className="font-bold text-sky-300">{item.title}</span>
                              <span className="text-gray-400 text-[11px]">at</span>
                              <span className="font-semibold">{item.company}</span>
                              {item.source === 'resume' && (
                                <span
                                  title="Extracted from resume"
                                  className="px-1.5 py-0.2 rounded text-[8px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 whitespace-nowrap">
                                  from resume
                                </span>
                              )}
                              {item.isCurrent && (
                                <span className="px-1.5 py-0.2 rounded text-[8px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                                  Current
                                </span>
                              )}
                            </div>
                            {dateRange && (
                              <div className="flex items-center space-x-1 text-[10px] text-gray-400">
                                <FiCalendar className="size-2.5 shrink-0" />
                                <span>{dateRange}</span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center space-x-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditWorkExp(item)}
                              title="Edit position"
                              className="p-1 text-gray-400 hover:text-sky-400 transition-colors cursor-pointer">
                              <FiEdit2 className="size-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteWorkExp(item.id)}
                              title="Delete position"
                              className="p-1 text-gray-400 hover:text-red-400 transition-colors cursor-pointer">
                              <FiTrash2 className="size-3" />
                            </button>
                          </div>
                        </div>
                        {item.description && (
                          <p className="mt-1.5 text-[11px] text-gray-300 opacity-90 leading-relaxed whitespace-pre-line border-t border-gray-200/10 pt-1.5">
                            {item.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                !showWorkExpForm && (
                  <div
                    className={`p-3 rounded-lg border text-xs text-center ${
                      isDarkMode
                        ? 'border-slate-800 bg-slate-900/30 text-gray-400'
                        : 'border-gray-100 bg-gray-50/50 text-gray-500'
                    }`}>
                    No work experience positions added yet. Click{' '}
                    <button
                      type="button"
                      onClick={() => setShowWorkExpForm(true)}
                      className="text-sky-400 hover:underline font-semibold cursor-pointer">
                      "Add Position"
                    </button>{' '}
                    or upload a resume.
                  </div>
                )
              )}
            </>
          )}
        </div>

        {/* Skills & Experience per Skill */}
        <div className="pt-3 border-t border-gray-200/20 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-1.5">
              <FiAward className="size-3.5 text-sky-400" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400">
                Skill Experience (Years)
              </span>
            </div>
            <span className="text-[10px] text-gray-400">Used for "years with X" questions</span>
          </div>

          {/* Existing Skills Experience List */}
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(profile.skillExperience || {}).map(([skill, yrs]) => {
              const isFromResume = (profile.autoExtractedSkills || []).some(
                s => s.toLowerCase() === skill.toLowerCase(),
              );
              return (
                <div
                  key={skill}
                  className={`flex items-center justify-between p-2 rounded-lg border text-xs ${
                    isDarkMode ? 'border-sky-900 bg-slate-900/60' : 'border-sky-100 bg-white/70'
                  }`}>
                  <div className="flex items-center min-w-0 mr-1.5 overflow-hidden">
                    <span className="font-semibold truncate text-sky-300">{skill}</span>
                    {isFromResume && (
                      <span
                        title="Auto-extracted from resume"
                        className="ml-1 px-1 py-0.2 rounded text-[8px] font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30 whitespace-nowrap shrink-0">
                        from resume
                      </span>
                    )}
                  </div>
                  <div className="flex items-center space-x-1 shrink-0">
                    <input
                      type="number"
                      min="0"
                      max="99"
                      value={yrs}
                      onChange={async e => {
                        const newYrs = Math.max(0, Math.min(99, Number(e.target.value) || 0));
                        await careerBrainStore.saveSkillExperience(skill, newYrs);
                        const updated = await careerBrainStore.getCareerBrain();
                        setProfile(updated);
                      }}
                      className={`w-10 text-center rounded border py-0.5 text-xs font-bold outline-none ${
                        isDarkMode
                          ? 'border-slate-700 bg-slate-800 text-white'
                          : 'border-gray-200 bg-white text-gray-800'
                      }`}
                    />
                    <span className="text-[10px] text-gray-400">yrs</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const updated = { ...(profile.skillExperience || {}) };
                        delete updated[skill];
                        const updatedAuto = (profile.autoExtractedSkills || []).filter(
                          s => s.toLowerCase() !== skill.toLowerCase(),
                        );
                        await careerBrainStore.updateCareerBrain({
                          skillExperience: updated,
                          autoExtractedSkills: updatedAuto,
                        });
                        setProfile(prev => ({
                          ...prev,
                          skillExperience: updated,
                          autoExtractedSkills: updatedAuto,
                        }));
                      }}
                      title="Remove skill"
                      className="p-0.5 text-gray-400 hover:text-red-400 transition-colors ml-1 cursor-pointer">
                      <FiTrash2 className="size-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Skill Experience Row */}
          <div className="flex items-center space-x-2 pt-1">
            <SkillAutocompleteInput
              value={newSkillName}
              onChange={setNewSkillName}
              onSelect={skill => setNewSkillName(skill)}
              placeholder="e.g. Spring Boot, Node.js"
              isDarkMode={isDarkMode}
              className={`w-full rounded-lg border px-2.5 py-1 text-xs outline-none transition-colors ${
                isDarkMode
                  ? 'border-sky-900 bg-slate-900 text-white focus:border-sky-500'
                  : 'border-sky-200 bg-white text-gray-900 focus:border-sky-400'
              }`}
              onKeyDown={async e => {
                if (e.key === 'Enter' && newSkillName.trim() && newSkillYears !== '') {
                  e.preventDefault();
                  const yrs = Math.max(0, Math.min(99, Number(newSkillYears)));
                  await careerBrainStore.saveSkillExperience(newSkillName.trim(), yrs);
                  const updated = await careerBrainStore.getCareerBrain();
                  setProfile(updated);
                  setNewSkillName('');
                  setNewSkillYears('');
                }
              }}
            />
            <input
              type="number"
              min="0"
              max="99"
              placeholder="Yrs"
              value={newSkillYears}
              onChange={e => setNewSkillYears(e.target.value === '' ? '' : Number(e.target.value))}
              onKeyDown={async e => {
                if (e.key === 'Enter' && newSkillName.trim() && newSkillYears !== '') {
                  e.preventDefault();
                  const yrs = Math.max(0, Math.min(99, Number(newSkillYears)));
                  await careerBrainStore.saveSkillExperience(newSkillName.trim(), yrs);
                  const updated = await careerBrainStore.getCareerBrain();
                  setProfile(updated);
                  setNewSkillName('');
                  setNewSkillYears('');
                }
              }}
              className={`w-14 shrink-0 rounded-lg border px-2 py-1 text-xs text-center outline-none ${
                isDarkMode ? 'border-sky-900 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
              }`}
            />
            <button
              onClick={async () => {
                if (!newSkillName.trim() || newSkillYears === '') return;
                const yrs = Math.max(0, Math.min(99, Number(newSkillYears)));
                await careerBrainStore.saveSkillExperience(newSkillName.trim(), yrs);
                const updated = await careerBrainStore.getCareerBrain();
                setProfile(updated);
                setNewSkillName('');
                setNewSkillYears('');
              }}
              disabled={!newSkillName.trim() || newSkillYears === ''}
              className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-bold text-white hover:bg-sky-400 disabled:opacity-50 cursor-pointer shrink-0">
              Add
            </button>
          </div>
        </div>

        {/* Saved Golden Answers (with Edit / Delete) */}
        <div className="pt-3 border-t border-gray-200/20 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400">Saved Golden Answers</span>
            <button
              onClick={() => setShowAddGolden(!showAddGolden)}
              className="flex items-center space-x-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300 cursor-pointer">
              <FiPlus className="size-3" />
              <span>Add Custom Q&A</span>
            </button>
          </div>

          {/* Add Golden Answer Form */}
          {showAddGolden && (
            <div
              className={`p-2.5 rounded-lg border space-y-2 text-xs ${
                isDarkMode ? 'border-sky-900 bg-slate-900/80' : 'border-sky-100 bg-sky-50/50'
              }`}>
              <input
                type="text"
                placeholder="Question (e.g. Do you have experience with AWS?)"
                value={newQuestionText}
                onChange={e => setNewQuestionText(e.target.value)}
                className={`w-full rounded border px-2 py-1 text-xs outline-none ${
                  isDarkMode ? 'border-slate-700 bg-slate-800 text-white' : 'border-gray-200 bg-white'
                }`}
              />
              <input
                type="text"
                placeholder="Answer (e.g. Yes, 3 years)"
                value={newAnswerText}
                onChange={e => setNewAnswerText(e.target.value)}
                className={`w-full rounded border px-2 py-1 text-xs outline-none ${
                  isDarkMode ? 'border-slate-700 bg-slate-800 text-white' : 'border-gray-200 bg-white'
                }`}
              />
              <div className="flex space-x-2">
                <button
                  onClick={async () => {
                    if (!newQuestionText.trim() || !newAnswerText.trim()) return;
                    await careerBrainStore.saveGoldenAnswer(newQuestionText.trim(), newAnswerText.trim());
                    const updated = await careerBrainStore.getCareerBrain();
                    setProfile(updated);
                    setNewQuestionText('');
                    setNewAnswerText('');
                    setShowAddGolden(false);
                  }}
                  className="rounded bg-sky-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-sky-400 cursor-pointer">
                  Save
                </button>
                <button
                  onClick={() => setShowAddGolden(false)}
                  className="rounded bg-gray-600 px-2.5 py-1 text-[11px] font-semibold text-gray-200 hover:bg-gray-500 cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Golden Answers List */}
          <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
            {(profile.goldenAnswers || []).map(ga => (
              <div
                key={ga.id}
                className={`p-2 rounded-lg border flex items-center justify-between text-xs transition-colors ${
                  isDarkMode
                    ? 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                    : 'border-gray-100 bg-white hover:border-gray-200 shadow-sm'
                }`}>
                <div className="flex-1 mr-2 truncate">
                  <p className={`font-medium truncate ${isDarkMode ? 'text-gray-300' : 'text-slate-800'}`}>
                    {ga.question}
                  </p>
                  {editingGoldenId === ga.id ? (
                    <div className="flex items-center space-x-1.5 mt-1">
                      <input
                        type="text"
                        value={editingGoldenAnswer}
                        onChange={e => setEditingGoldenAnswer(e.target.value)}
                        className={`flex-1 rounded border px-2 py-0.5 text-xs outline-none ${
                          isDarkMode
                            ? 'border-sky-700 bg-slate-800 text-white'
                            : 'border-sky-300 bg-white text-gray-900'
                        }`}
                      />
                      <button
                        onClick={async () => {
                          if (!editingGoldenAnswer.trim()) return;
                          await careerBrainStore.updateGoldenAnswer(ga.id, editingGoldenAnswer.trim());
                          const updated = await careerBrainStore.getCareerBrain();
                          setProfile(updated);
                          setEditingGoldenId(null);
                        }}
                        title="Save"
                        className="p-1 text-emerald-400 hover:text-emerald-300 cursor-pointer">
                        <FiCheck className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setEditingGoldenId(null)}
                        title="Cancel"
                        className="p-1 text-gray-400 hover:text-gray-300 cursor-pointer">
                        <FiX className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <p
                      className={`font-semibold truncate text-[11px] mt-0.5 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-700'}`}>
                      {ga.answer}
                    </p>
                  )}
                </div>
                {editingGoldenId !== ga.id && (
                  <div className="flex items-center space-x-1 shrink-0">
                    <button
                      onClick={() => {
                        setEditingGoldenId(ga.id);
                        setEditingGoldenAnswer(ga.answer);
                      }}
                      title="Edit Answer"
                      className="p-1 text-gray-400 hover:text-sky-400 transition-colors cursor-pointer">
                      <FiEdit2 className="size-3" />
                    </button>
                    <button
                      onClick={async () => {
                        await careerBrainStore.deleteGoldenAnswer(ga.id);
                        const updated = await careerBrainStore.getCareerBrain();
                        setProfile(updated);
                      }}
                      title="Delete Answer"
                      className="p-1 text-gray-400 hover:text-red-400 transition-colors cursor-pointer">
                      <FiTrash2 className="size-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Settings & Automation Safeties Quick Link */}
      <div
        className={`rounded-xl border p-3 flex items-center justify-between text-xs ${
          isDarkMode ? 'border-sky-900/60 bg-slate-800/60' : 'border-sky-100 bg-white/80 shadow-sm'
        }`}>
        <div>
          <span className="font-semibold text-[11px] block text-sky-400">Career Brain & Automation Safeties</span>
          <span className="text-[10px] opacity-60">Manage match score threshold, negative keywords & safeties</span>
        </div>
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 border border-sky-500/30 cursor-pointer transition-colors">
          <span>Open Settings</span>
          <FiExternalLink className="size-3" />
        </button>
      </div>
    </div>
  );
}
export default ResumeProfileView;
