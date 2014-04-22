function MP4Box() {
	this.log_level = this.LOG_LEVEL_INFO;

	this.inputStream = null;
	this.inputIsoFile = null;
	this.onReady = null;
	this.readySent = false;
	this.onFragment = null;
	this.onError = null;

	this.default_options = {
		fragdur : 500,
		startWithRap: true,
		noDefault: false
	};
	this.fragmentedTracks = new Array();
	this.isFragmentationStarted = false;
	this.nextMoofNumber = 0;
}

MP4Box.prototype.LOG_LEVEL_ERROR 	= 4;
MP4Box.prototype.LOG_LEVEL_WARNING 	= 3;
MP4Box.prototype.LOG_LEVEL_INFO 	= 2;
MP4Box.prototype.LOG_LEVEL_DEBUG 	= 1;

MP4Box.prototype.log = function(level, msg) {
	if (level >= this.log_level) {
		console.log("[MP4Box] "+msg);
	}
}

MP4Box.prototype.setFragmentOptions = function(id, user, options) {
	var fragTrack = {};
	this.fragmentedTracks.push(fragTrack);
	fragTrack.id = id;
	fragTrack.user = user;
	fragTrack.nextSample = 0;
	if (options) {
		fragTrack.dur = options.dur || this.default_options.fragdur;
		fragTrack.startWithRap = options.startWithRap || this.default_options.startWithRap;
		fragTrack.noDefault = options.noDefault || this.default_options.noDefault;
	}
}

MP4Box.prototype.unsetFragmentOptions = function(id) {
	var index = -1;
	for (var i = 0; i < this.fragmentedTracks.length; i++) {
		var fragTrack = this.fragmentedTracks[i];
		if (fragTrack.id == id) {
			index = i;
		}
	}
	if (index > -1) {
		this.fragmentedTracks.splice(index, 1);
	}
}

MP4Box.prototype.createSingleSampleMoof = function(sample) {
	var moof = new BoxParser.moofBox();
	var mfhd = new BoxParser.mfhdBox();
	mfhd.sequence_number = this.nextMoofNumber;
	this.nextMoofNumber++;
	moof.boxes.push(mfhd);
	var traf = new BoxParser.trafBox();
	moof.boxes.push(traf);
	var tfhd = new BoxParser.tfhdBox();
	traf.boxes.push(tfhd);
	tfhd.track_ID = sample.track_id;
	tfhd.flags = BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF;
	var tfdt = new BoxParser.tfdtBox();
	traf.boxes.push(tfdt);
	tfdt.baseMediaDecodeTime = sample.dts;
	var trun = new BoxParser.trunBox();
	traf.boxes.push(trun);
	moof.trun = trun;
	trun.flags = BoxParser.TRUN_FLAGS_DATA_OFFSET | BoxParser.TRUN_FLAGS_DURATION | 
				 BoxParser.TRUN_FLAGS_SIZE | BoxParser.TRUN_FLAGS_FLAGS | 
				 BoxParser.TRUN_FLAGS_CTS_OFFSET;
	trun.data_offset = 0;
	trun.first_sample_flags = 0;
	trun.sample_count = 1;
	trun.sample_duration = new Array();
	trun.sample_duration[0] = sample.duration;
	trun.sample_size = new Array();
	trun.sample_size[0] = sample.size;
	trun.sample_flags = new Array();
	trun.sample_flags[0] = 0;
	trun.sample_composition_time_offset = new Array();
	trun.sample_composition_time_offset[0] = sample.cts - sample.dts;
	return moof;
}

MP4Box.prototype.createFragment = function(input, track_id, sampleNumber, stream_) {
	var trak = this.inputIsoFile.getTrackById(track_id);
	var sample = trak.samples[sampleNumber];

	if (this.inputStream.byteLength < sample.offset + sample.size) {
		return null;
	}
	
	var stream = stream_ || new DataStream();
	stream.endianness = DataStream.BIG_ENDIAN;

	var moof = this.createSingleSampleMoof(sample);
	moof.write(stream);

	/* adjusting the data_offset now that the moof size is known*/
	moof.trun.data_offset = moof.size+8; //8 is mdat header
	this.log(MP4Box.LOG_LEVEL_DEBUG, "Adjusting data_offset with new value "+moof.trun.data_offset);
	stream.adjustUint32(moof.trun.data_offset_position, moof.trun.data_offset);
		
	var mdat = new BoxParser.mdatBox();
	mdat.data = new ArrayBuffer();
	this.inputStream.seek(sample.offset);
	mdat.data = this.inputStream.readUint8Array(sample.size);
	mdat.write(stream);
	return stream;
}

MP4Box.prototype.open = function(ab) {
	var concatenateBuffers = function(buffer1, buffer2) {
	  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
	  tmp.set(new Uint8Array(buffer1), 0);
	  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
	  return tmp.buffer;
	};
	
	var stream;
	
	if (!this.inputStream) {
		this.inputStream = new DataStream(ab, 0, DataStream.BIG_ENDIAN);	
	} else {
		this.inputStream.buffer = concatenateBuffers(this.inputStream.buffer, ab);
	}
	if (!this.inputIsoFile) {
		this.inputIsoFile = new ISOFile();
	}
	if (!this.inputIsoFile.moov) {
		this.inputIsoFile.parse(this.inputStream);
	}
	if (!this.inputIsoFile.moov) {
		return false;	
	} else {
		this.inputIsoFile.buildSampleLists();
		if (this.onReady && !this.readySent) {
			var info = this.getInfo();
			this.readySent = true;
			this.onReady(info);
		}	
		return true;
	}
}

MP4Box.prototype.processFragments = function() {
	var stream = null;
	if (this.isFragmentationStarted) {
		for (var i = 0; i < this.fragmentedTracks.length; i++) {
			for (var j = this.fragmentedTracks[i].nextSample; j < 50; j++) {
//			var trak = this.inputIsoFile.getTrackById(this.fragmentedTracks[i].id);			
//			for (var j = this.fragmentedTracks[i].nextSample; j < trak.samples.length; j++) {
				stream = this.createFragment(this.inputIsoFile, this.fragmentedTracks[i].id, this.fragmentedTracks[i].nextSample, stream);
				this.log(MP4Box.LOG_LEVEL_INFO, "Sending media fragment on track #"+this.fragmentedTracks[i].id
												+" for sample "+this.fragmentedTracks[i].nextSample); 
				this.fragmentedTracks[i].nextSample++;
				if (this.onFragment) this.onFragment(this.fragmentedTracks[i].user, stream.buffer);
			}
		}
	}
}

MP4Box.prototype.appendBuffer = function(ab) {
	var stream;
	var is_open = this.open(ab);
	if (!is_open) return;
	this.processFragments();
}

MP4Box.prototype.getInfo = function() {
	var movie = {};
	movie.duration = this.inputIsoFile.moov.mvhd.duration;
	movie.timescale = this.inputIsoFile.moov.mvhd.timescale;
	movie.isFragmented = (this.inputIsoFile.moov.mvex != null);
	if (movie.isFragmented) {
		movie.fragment_duration = this.inputIsoFile.moov.mvex.mehd.fragment_duration;
	}
	movie.isProgressive = this.inputIsoFile.isProgressive;
	movie.hasIOD = (this.inputIsoFile.moov.iods != null);
	movie.brands = []; 
	movie.brands.push(this.inputIsoFile.ftyp.major_brand);
	movie.brands.join(this.inputIsoFile.ftyp.compatible_brands);
	var _1904 = (new Date(4, 0, 1, 0, 0, 0, 0).getTime());
	movie.created = new Date(_1904+this.inputIsoFile.moov.mvhd.creation_time*1000);
	movie.modified = new Date(_1904+this.inputIsoFile.moov.mvhd.modification_time*1000);
	movie.tracks = new Array();
	for (i = 0; i < this.inputIsoFile.moov.traks.length; i++) {
		var trak = this.inputIsoFile.moov.traks[i];
		var sample_desc = trak.mdia.minf.stbl.stsd.entries[0];
		var track = {};
		movie.tracks.push(track);
		track.id = trak.tkhd.track_id;
		track.created = new Date(_1904+trak.tkhd.creation_time*1000);
		track.modified = new Date(_1904+trak.tkhd.modification_time*1000);
		track.movie_duration = trak.tkhd.duration;
		track.layer = trak.tkhd.layer;
		track.alternate_group = trak.tkhd.alternate_group;
		track.volume = trak.tkhd.volume;
		track.matrix = trak.tkhd.matrix;
		track.track_width = trak.tkhd.width/(1<<16);
		track.track_height = trak.tkhd.height/(1<<16);
		track.timescale = trak.mdia.mdhd.timescale;
		track.duration = trak.mdia.mdhd.duration;
		track.codec = sample_desc.getCodec();		
		track.video_width = sample_desc.getWidth();		
		track.video_height = sample_desc.getHeight();		
		track.audio_sample_rate = sample_desc.getSampleRate();		
		track.audio_channel_count = sample_desc.getChannelCount();		
		track.language = trak.mdia.mdhd.languageString;
		track.nb_samples = trak.samples.length;
	}
	return movie;
}

MP4Box.prototype.getInitializationSegment = function() {
	var stream = new DataStream();
	stream.endianness = DataStream.BIG_ENDIAN;
	this.inputIsoFile.writeInitializationSegment(stream);
	return stream.buffer;
}

MP4Box.prototype.initializeFragmentation = function() {
	if (!this.isFragmentationStarted) {
		this.isFragmentationStarted = true;		
		this.nextMoofNumber = 0;
		this.inputIsoFile.resetTables();
	}	
	var initSegs = new Array();
	for (var j = 0; j < this.inputIsoFile.moov.boxes.length; j++) {
		var box = this.inputIsoFile.moov.boxes[j];
		if (box.type == "trak") {
			this.inputIsoFile.moov.boxes[j] = null;
		}
	}
	for (var i = 0; i < this.fragmentedTracks.length; i++) {
		var trak = this.inputIsoFile.getTrackById(this.fragmentedTracks[i].id);
		for (var j = 0; j < this.inputIsoFile.moov.boxes.length; j++) {
			var box = this.inputIsoFile.moov.boxes[j];
			if (box == null) {
				this.inputIsoFile.moov.boxes[j] = trak;
			}
		}
		seg = {};
		seg.track_id = trak.tkhd.track_id;
		seg.user = this.fragmentedTracks[i].user;
		seg.buffer = this.getInitializationSegment();
		initSegs.push(seg);
	}
	return initSegs;
}

MP4Box.prototype.flush = function() {
	this.log(MP4Box.LOG_LEVEL_INFO, "Flushing remaining samples");
	this.processFragments();
}