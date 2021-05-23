const fs = require('fs-extra')
const path = require('path')
const config_api = require('./config');
const archiver = require('archiver');

const is_windows = process.platform === 'win32';

// replaces .webm with appropriate extension
function getTrueFileName(unfixed_path, type) {
    let fixed_path = unfixed_path;

    const new_ext = (type === 'audio' ? 'mp3' : 'mp4');
    let unfixed_parts = unfixed_path.split('.');
    const old_ext = unfixed_parts[unfixed_parts.length-1];


    if (old_ext !== new_ext) {
        unfixed_parts[unfixed_parts.length-1] = new_ext;
        fixed_path = unfixed_parts.join('.');
    }
    return fixed_path;
}

async function getDownloadedFilesByType(basePath, type, full_metadata = false) {
    // return empty array if the path doesn't exist
    if (!(await fs.pathExists(basePath))) return [];

    let files = [];
    const ext = type === 'audio' ? 'mp3' : 'mp4';
    var located_files = await recFindByExt(basePath, ext);
    for (let i = 0; i < located_files.length; i++) {
        let file = located_files[i];
        var file_path = file.substring(basePath.includes('\\') ? basePath.length+1 : basePath.length, file.length);

        var stats = await fs.stat(file);

        var id = file_path.substring(0, file_path.length-4);
        var jsonobj = await getJSONByType(type, id, basePath);
        if (!jsonobj) continue;
        if (full_metadata) {
            jsonobj['id'] = id;
            files.push(jsonobj);
            continue;
        }
        var upload_date = jsonobj.upload_date;
        upload_date = upload_date ? `${upload_date.substring(0, 4)}-${upload_date.substring(4, 6)}-${upload_date.substring(6, 8)}` : null;

        var isaudio = type === 'audio';
        var file_obj = new File(id, jsonobj.title, jsonobj.thumbnail, isaudio, jsonobj.duration, jsonobj.webpage_url, jsonobj.uploader,
                                stats.size, file, upload_date, jsonobj.description, jsonobj.view_count, jsonobj.height, jsonobj.abr);
        files.push(file_obj);
    }
    return files;
}

async function createContainerZipFile(container_obj, container_file_objs) {
    const container_files_to_download = [];
    for (let i = 0; i < container_file_objs.length; i++) {
        const container_file_obj = container_file_objs[i];
        container_files_to_download.push(container_file_obj.path);
    }
    return await createZipFile(path.join('appdata', container_obj.name + '.zip'), container_files_to_download);
}

async function createZipFile(zip_file_path, file_paths) {
    let output = fs.createWriteStream(zip_file_path);

    var archive = archiver('zip', {
        gzip: true,
        zlib: { level: 9 } // Sets the compression level.
    });

    archive.on('error', function(err) {
        logger.error(err);
        throw err;
    });

    // pipe archive data to the output file
    archive.pipe(output);

    for (let file_path of file_paths) {
        const file_name = path.parse(file_path).base;
        archive.file(file_path, {name: file_name})
    }

    await archive.finalize();

    // wait a tiny bit for the zip to reload in fs
    await wait(100);
    return zip_file_path;
}

function getJSONMp4(name, customPath, openReadPerms = false) {
    var obj = null; // output
    if (!customPath) customPath = config_api.getConfigItem('ytdl_video_folder_path');
    var jsonPath = path.join(customPath, name + ".info.json");
    var alternateJsonPath = path.join(customPath, name + ".mp4.info.json");
    if (fs.existsSync(jsonPath))
    {
        obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } else if (fs.existsSync(alternateJsonPath)) {
        obj = JSON.parse(fs.readFileSync(alternateJsonPath, 'utf8'));
    }
    else obj = 0;
    return obj;
}

function getJSONMp3(name, customPath, openReadPerms = false) {
    var obj = null;
    if (!customPath) customPath = config_api.getConfigItem('ytdl_audio_folder_path');
    var jsonPath = path.join(customPath, name + ".info.json");
    var alternateJsonPath = path.join(customPath, name + ".mp3.info.json");
    if (fs.existsSync(jsonPath)) {
        obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    else if (fs.existsSync(alternateJsonPath)) {
        obj = JSON.parse(fs.readFileSync(alternateJsonPath, 'utf8'));
    }
    else
        obj = 0;

    return obj;
}

function getJSONByType(type, name, customPath, openReadPerms = false) {
    return type === 'audio' ? getJSONMp3(name, customPath, openReadPerms) : getJSONMp4(name, customPath, openReadPerms)
}

function getDownloadedThumbnail(name, type, customPath = null) {
    if (!customPath) customPath = type === 'audio' ? config_api.getConfigItem('ytdl_audio_folder_path') : config_api.getConfigItem('ytdl_video_folder_path');

    let jpgPath = path.join(customPath, name + '.jpg');
    let webpPath = path.join(customPath, name + '.webp');
    let pngPath = path.join(customPath, name + '.png');

    if (fs.existsSync(jpgPath))
        return jpgPath;
    else if (fs.existsSync(webpPath))
        return webpPath;
    else if (fs.existsSync(pngPath))
        return pngPath;
    else
        return null;
}

function getExpectedFileSize(input_info_jsons) {
    // treat single videos as arrays to have the file sizes checked/added to. makes the code cleaner
    const info_jsons = Array.isArray(input_info_jsons) ? input_info_jsons : [input_info_jsons];

    let expected_filesize = 0;
    info_jsons.forEach(info_json => {
        if (info_json['filesize']) {
            expected_filesize += info_json['filesize'];
            return;
        }
        const formats = info_json['format_id'].split('+');
        let individual_expected_filesize = 0;
        formats.forEach(format_id => {
            info_json.formats.forEach(available_format => {
                if (available_format.format_id === format_id && available_format.filesize) {
                    individual_expected_filesize += available_format.filesize;
                }
            });
        });
        expected_filesize += individual_expected_filesize;
    });

    return expected_filesize;
}

function fixVideoMetadataPerms(name, type, customPath = null) {
    if (is_windows) return;
    if (!customPath) customPath = type === 'audio' ? config_api.getConfigItem('ytdl_audio_folder_path')
                                                   : config_api.getConfigItem('ytdl_video_folder_path');

    const ext = type === 'audio' ? '.mp3' : '.mp4';

    const files_to_fix = [
        // JSONs
        path.join(customPath, name + '.info.json'),
        path.join(customPath, name + ext + '.info.json'),
        // Thumbnails
        path.join(customPath, name + '.webp'),
        path.join(customPath, name + '.jpg')
    ];

    for (const file of files_to_fix) {
        if (!fs.existsSync(file)) continue;
        fs.chmodSync(file, 0o644);
    }
}

function deleteJSONFile(name, type, customPath = null) {
    if (!customPath) customPath = type === 'audio' ? config_api.getConfigItem('ytdl_audio_folder_path')
                                                   : config_api.getConfigItem('ytdl_video_folder_path');

    const ext = type === 'audio' ? '.mp3' : '.mp4';
    let json_path = path.join(customPath, name + '.info.json');
    let alternate_json_path = path.join(customPath, name + ext + '.info.json');

    if (fs.existsSync(json_path)) fs.unlinkSync(json_path);
    if (fs.existsSync(alternate_json_path)) fs.unlinkSync(alternate_json_path);
}


async function recFindByExt(base,ext,files,result)
{
    files = files || (await fs.readdir(base))
    result = result || []

    for (const file of files) {
        var newbase = path.join(base,file)
        if ( (await fs.stat(newbase)).isDirectory() )
        {
            result = await recFindByExt(newbase,ext,await fs.readdir(newbase),result)
        }
        else
        {
            if ( file.substr(-1*(ext.length+1)) == '.' + ext )
            {
                result.push(newbase)
            }
        }
    }
    return result
}

function removeFileExtension(filename) {
    const filename_parts = filename.split('.');
    filename_parts.splice(filename_parts.length - 1);
    return filename_parts.join('.');
}

/**
 * setTimeout, but its a promise.
 * @param {number} ms
 */
 async function wait(ms) {
    await new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

// objects

function File(id, title, thumbnailURL, isAudio, duration, url, uploader, size, path, upload_date, description, view_count, height, abr) {
    this.id = id;
    this.title = title;
    this.thumbnailURL = thumbnailURL;
    this.isAudio = isAudio;
    this.duration = duration;
    this.url = url;
    this.uploader = uploader;
    this.size = size;
    this.path = path;
    this.upload_date = upload_date;
    this.description = description;
    this.view_count = view_count;
    this.height = height;
    this.abr = abr;
}

module.exports = {
    getJSONMp3: getJSONMp3,
    getJSONMp4: getJSONMp4,
    getTrueFileName: getTrueFileName,
    getDownloadedThumbnail: getDownloadedThumbnail,
    getExpectedFileSize: getExpectedFileSize,
    fixVideoMetadataPerms: fixVideoMetadataPerms,
    deleteJSONFile: deleteJSONFile,
    getDownloadedFilesByType: getDownloadedFilesByType,
    createContainerZipFile: createContainerZipFile,
    recFindByExt: recFindByExt,
    removeFileExtension: removeFileExtension,
    wait: wait,
    File: File
}
